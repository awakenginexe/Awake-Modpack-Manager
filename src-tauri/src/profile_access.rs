//! Why a Launcher data folder cannot be shared, and the one permission fix the user can ask for.
//!
//! Awake Launcher only publishes its integration endpoint from a data root that the current user
//! owns and that no other account can write to (launcher/awake/integration/ProfileAccess.cpp).
//! `%APPDATA%` always passes. A compact or custom folder on another drive inherits that drive's
//! "Authenticated Users: Modify" entry and fails, so the Launcher runs but never appears here.

use std::path::Path;

/// The folder has entries that let other accounts change it. `make_private` can fix this.
pub const PUBLIC_WRITE: &str = "public-write";
/// The folder belongs to another account, or its drive has no Windows permissions.
pub const FOREIGN_OWNER: &str = "foreign-owner";

#[cfg(windows)]
mod imp {
    use super::{FOREIGN_OWNER, PUBLIC_WRITE};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, EqualSid, GetAce, GetTokenInformation, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER,
        ACL, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const ACCESS_ALLOWED: u8 = 0;
    const ACCESS_DENIED: u8 = 1;
    const MAX_SID: usize = 68;
    /// The rights ProfileAccess.cpp treats as "write": FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY,
    /// FILE_WRITE_EA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, DELETE, WRITE_DAC, WRITE_OWNER,
    /// GENERIC_ALL and GENERIC_WRITE.
    const WRITE_RIGHTS: u32 = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x1000_0000 | 0x4000_0000;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// TOKEN_USER of this process; the SID inside lives as long as the buffer.
    fn current_user() -> Option<Vec<u8>> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let mut size = 0u32;
        unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size) };
        let mut user = vec![0u8; size as usize];
        let ok = size > 0 && unsafe { GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), size, &mut size) } != 0;
        unsafe { CloseHandle(token) };
        ok.then_some(user)
    }

    fn well_known(kind: i32) -> Option<Vec<u8>> {
        let mut sid = vec![0u8; MAX_SID];
        let mut size = MAX_SID as u32;
        (unsafe { CreateWellKnownSid(kind, null_mut(), sid.as_mut_ptr().cast(), &mut size) } != 0).then_some(sid)
    }

    struct Security {
        descriptor: *mut core::ffi::c_void,
        owner: PSID,
        acl: *mut ACL,
    }
    impl Drop for Security {
        fn drop(&mut self) {
            unsafe { LocalFree(self.descriptor) };
        }
    }
    fn read_security(path: &Path) -> Option<Security> {
        let name = wide(path);
        let mut security = Security { descriptor: null_mut(), owner: null_mut(), acl: null_mut() };
        let status = unsafe {
            GetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &mut security.owner, null_mut(), &mut security.acl, null_mut(), &mut security.descriptor)
        };
        (status == 0).then_some(security)
    }

    pub fn blocked(root: &Path) -> Option<&'static str> {
        let path = std::fs::canonicalize(root).ok()?;
        let user = current_user()?;
        let (system, admins) = (well_known(WinLocalSystemSid)?, well_known(WinBuiltinAdministratorsSid)?);
        let me = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
        let security = read_security(&path)?;
        if security.owner.is_null() || security.acl.is_null() || unsafe { EqualSid(security.owner, me) } == 0 {
            return Some(FOREIGN_OWNER);
        }
        for index in 0..unsafe { (*security.acl).AceCount } as u32 {
            let mut raw: *mut core::ffi::c_void = null_mut();
            if unsafe { GetAce(security.acl, index, &mut raw) } == 0 {
                return Some(PUBLIC_WRITE);
            }
            let header = unsafe { &*(raw as *const ACE_HEADER) };
            if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 || header.AceType == ACCESS_DENIED {
                continue;
            }
            if header.AceType != ACCESS_ALLOWED {
                return Some(PUBLIC_WRITE);
            }
            let ace = raw as *const ACCESS_ALLOWED_ACE;
            let grantee: PSID = unsafe { core::ptr::addr_of!((*ace).SidStart) } as PSID;
            let trusted = [me, system.as_ptr() as PSID, admins.as_ptr() as PSID].iter().any(|sid| unsafe { EqualSid(grantee, *sid) } != 0);
            if unsafe { (*ace).Mask } & WRITE_RIGHTS != 0 && !trusted {
                return Some(PUBLIC_WRITE);
            }
        }
        None
    }

    /// Replace the folder's entries with the three a normal `%APPDATA%` install has. Windows applies
    /// them to everything inside, which can take a while on a large folder.
    pub fn make_private(root: &Path) -> Result<(), String> {
        let user = current_user().ok_or("Could not read the current Windows account.")?;
        let system = well_known(WinLocalSystemSid).ok_or("Could not read the Windows system account.")?;
        let admins = well_known(WinBuiltinAdministratorsSid).ok_or("Could not read the Windows administrators group.")?;
        let me = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
        let mut entries: [EXPLICIT_ACCESS_W; 3] = unsafe { core::mem::zeroed() };
        for (entry, sid) in entries.iter_mut().zip([me, system.as_ptr() as PSID, admins.as_ptr() as PSID]) {
            entry.grfAccessPermissions = FILE_ALL_ACCESS;
            entry.grfAccessMode = SET_ACCESS;
            entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.ptstrName = sid as *mut u16;
        }
        let mut acl: *mut ACL = null_mut();
        let status = unsafe { SetEntriesInAclW(3, entries.as_ptr(), null(), &mut acl) };
        if status != 0 {
            return Err(format!("Could not prepare the folder permissions (Windows error {status})."));
        }
        let name = wide(root);
        let status = unsafe { SetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, null_mut(), null_mut(), acl, null()) };
        unsafe { LocalFree(acl.cast()) };
        if status != 0 {
            return Err(format!("Windows refused to change this folder's permissions (error {status})."));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::blocked;
#[cfg(not(windows))]
pub fn blocked(_: &Path) -> Option<&'static str> { None }

/// Applies the fix after refusing anything the check cannot vouch for. Callers pass only folders
/// discovery already found.
pub fn make_private(root: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(root).map_err(|e| format!("Cannot open this folder: {e}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("This data folder is a link, so its permissions were not changed.".into());
    }
    if root.parent().is_none() {
        return Err("This data folder is a whole drive, so its permissions were not changed. Move the Launcher data into a folder.".into());
    }
    match blocked(root) {
        None => Ok(()),
        Some(FOREIGN_OWNER) => Err("This folder belongs to another Windows account, so the Manager can't change it.".into()),
        Some(_) => {
            #[cfg(windows)]
            imp::make_private(root)?;
            match blocked(root) {
                None => Ok(()),
                Some(_) => Err("The folder permissions did not change as expected.".into()),
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    /// Hosted runners are administrators, so new folders belong to the Administrators group there.
    fn own_recursively(path: &Path) {
        let output = Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().unwrap();
        let text = String::from_utf8(output.stdout).unwrap();
        let sid = text.trim().rsplit(',').next().unwrap().trim_matches('"');
        let status = Command::new("icacls").arg(path).args(["/setowner", &format!("*{sid}"), "/T"]).output().unwrap().status;
        assert!(status.success());
    }

    fn open_to_authenticated_users(path: &Path) {
        let status = Command::new("icacls").arg(path).args(["/grant", "*S-1-5-11:(OI)(CI)M"]).output().unwrap().status;
        assert!(status.success());
    }

    #[test]
    fn matches_the_launcher_rule_and_fixes_folders_others_can_write() {
        let root = std::env::temp_dir().join(format!("awake-mm-access-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("instances")).unwrap();
        fs::write(root.join("instances/keep.txt"), b"keep").unwrap();
        own_recursively(&root);
        assert_eq!(blocked(&root), None, "a private temp folder is shareable");

        open_to_authenticated_users(&root);
        assert_eq!(blocked(&root), Some(PUBLIC_WRITE));
        assert_eq!(blocked(&root.join("instances")), Some(PUBLIC_WRITE), "inherited by children");

        make_private(&root).unwrap();
        assert_eq!(blocked(&root), None);
        assert_eq!(blocked(&root.join("instances")), None, "the fix reaches existing children");
        assert_eq!(fs::read(root.join("instances/keep.txt")).unwrap(), b"keep");
        make_private(&root).unwrap(); // already private: nothing to do
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_folder_owned_by_someone_else() {
        // %WINDIR% belongs to TrustedInstaller on every supported Windows.
        let windir = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap());
        assert_eq!(blocked(&windir), Some(FOREIGN_OWNER));
        assert!(make_private(&windir).is_err());
    }
}
