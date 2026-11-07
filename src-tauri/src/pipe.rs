//! Named-pipe transport for the Awake Launcher integration protocol 1.0.
//!
//! Framing (docs/modpack-manager/protocol.md, Launcher commit d3e6731a8 (unchanged since 058714ec7)): a 4-byte unsigned
//! big-endian length followed by one UTF-8 JSON object, at most 1 MiB, zero length invalid.
//! One request per connection at a time; the TypeScript client serializes calls.

use serde::Serialize;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

pub const MAX_FRAME: usize = 1 << 20;
const SERVER_PREFIX: &str = "awake-manager-v1-";
/// The Manager's own native helper (core-protocol.md 2.0: `awake-core-v2-<session UUID>`). Kept
/// apart from the Launcher prefix so neither side's commands can be pointed at the other.
pub const HELPER_PREFIX: &str = "awake-core-v2-";

#[derive(Debug, Serialize, Clone)]
pub struct IpcError {
    /// not-running | busy | identity | timeout | closed | frame | invalid | io
    pub code: &'static str,
    pub message: String,
}

impl IpcError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

struct Conn {
    file: Mutex<File>,
    /// Raw handle value, kept to cancel a blocked read from another thread.
    raw: usize,
}

#[derive(Default)]
pub struct Connections {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Arc<Conn>>>,
}

/// Only the Launcher's own pipe names may be opened, so the web view can't reach arbitrary pipes.
pub fn valid_server_name(name: &str) -> bool {
    valid_name(name, SERVER_PREFIX)
}

pub fn valid_helper_name(name: &str) -> bool {
    // core.schema.json $defs/descriptor: ^awake-core-v2-[a-f0-9-]{36}$
    valid_name(name, HELPER_PREFIX) && name.len() == HELPER_PREFIX.len() + 36 && !name.chars().any(|c| c.is_ascii_uppercase())
}

fn valid_name(name: &str, prefix: &str) -> bool {
    name.len() <= 128
        && name.starts_with(prefix)
        && name[prefix.len()..].chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && name.len() > prefix.len()
}

pub fn encode_frame(body: &[u8]) -> Result<Vec<u8>, IpcError> {
    if body.is_empty() || body.len() > MAX_FRAME {
        return Err(IpcError::new("frame", "Request frame is empty or larger than 1 MiB."));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

pub fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>, IpcError> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).map_err(closed)?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(IpcError::new("frame", format!("Launcher sent an invalid frame length ({len}).")));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(closed)?;
    Ok(body)
}

fn closed(e: std::io::Error) -> IpcError {
    IpcError::new("closed", format!("The Launcher connection closed: {e}"))
}

#[cfg(windows)]
mod win {
    use super::IpcError;
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn token_user(process: HANDLE) -> Option<Vec<u8>> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = Owned(token);
        let mut needed = 0u32;
        unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        if unsafe { GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), needed, &mut needed) } == 0 {
            return None;
        }
        Some(buf)
    }

    /// The descriptor is only a hint: confirm the pipe is served by the advertised process and that
    /// it runs as the current Windows user (protocol.md, "Availability and client rules").
    pub fn verify_server(file: &File, expected_pid: u32) -> Result<(), IpcError> {
        let handle = file.as_raw_handle() as HANDLE;
        let mut pid = 0u32;
        if unsafe { GetNamedPipeServerProcessId(handle, &mut pid) } == 0 {
            return Err(IpcError::new("identity", "Could not identify the process serving the Launcher pipe."));
        }
        if pid != expected_pid {
            return Err(IpcError::new("identity", format!("The pipe is served by process {pid}, not the advertised Launcher process {expected_pid}.")));
        }
        let process = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
        if process.0.is_null() {
            return Err(IpcError::new("identity", "Could not inspect the Launcher process."));
        }
        let (Some(server), Some(me)) = (token_user(process.0), token_user(unsafe { GetCurrentProcess() })) else {
            return Err(IpcError::new("identity", "Could not read the Launcher process owner."));
        };
        let server_sid = unsafe { (*(server.as_ptr() as *const TOKEN_USER)).User.Sid };
        let my_sid = unsafe { (*(me.as_ptr() as *const TOKEN_USER)).User.Sid };
        if unsafe { EqualSid(server_sid, my_sid) } == 0 {
            return Err(IpcError::new("identity", "The Launcher pipe belongs to a different Windows user."));
        }
        Ok(())
    }

    /// Full path of a running process's executable, or None if it has exited or can't be read.
    pub fn process_image(pid: u32) -> Option<std::path::PathBuf> {
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, QueryFullProcessImageNameW};
        let process = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
        if process.0.is_null() {
            return None;
        }
        let mut code = 0u32;
        // 259 = STILL_ACTIVE
        if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 || code != 259 {
            return None;
        }
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process.0, 0, buf.as_mut_ptr(), &mut len) } == 0 {
            return None;
        }
        use std::os::windows::ffi::OsStringExt;
        Some(std::ffi::OsString::from_wide(&buf[..len as usize]).into())
    }

    /// Create `dir` (its parent must exist) owned by the current user with a protected DACL that
    /// grants only that user, SYSTEM and Administrators: what the native helper requires of its
    /// profile (core handoff step 2). An inherited ACL from a shared parent is refused by the helper.
    pub fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
        let last = std::io::Error::last_os_error;
        let me = token_user(unsafe { GetCurrentProcess() }).ok_or_else(|| std::io::Error::other("Cannot read the current Windows user."))?;
        let sid = unsafe { (*(me.as_ptr() as *const TOKEN_USER)).User.Sid };
        let mut text: *mut u16 = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            return Err(last());
        }
        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
        let user = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        unsafe { LocalFree(text.cast()) };
        let sddl: Vec<u16> = format!("O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)").encode_utf16().chain([0]).collect();
        let mut sd = null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, null_mut()) } == 0 {
            return Err(last());
        }
        let attrs = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
        let path: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
        let ok = unsafe { CreateDirectoryW(path.as_ptr(), &attrs) };
        let err = last();
        unsafe { LocalFree(sd) };
        if ok == 0 { Err(err) } else { Ok(()) }
    }

    /// Whether this process is in a job that kills its members when the job closes (or we can't tell).
    pub fn in_kill_on_close_job() -> bool {
        use windows_sys::Win32::System::JobObjects::{JobObjectExtendedLimitInformation, QueryInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        let ok = unsafe { QueryInformationJobObject(null_mut(), JobObjectExtendedLimitInformation, (&mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size, null_mut()) };
        ok == 0 || info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
    }

    pub fn cancel_io(raw: usize) {
        unsafe { windows_sys::Win32::System::IO::CancelIoEx(raw as HANDLE, std::ptr::null()) };
    }

    pub fn raw(file: &File) -> usize {
        file.as_raw_handle() as usize
    }
}

#[cfg(not(windows))]
mod win {
    use super::IpcError;
    use std::fs::File;
    pub fn verify_server(_: &File, _: u32) -> Result<(), IpcError> {
        Err(IpcError::new("invalid", "Launcher IPC is supported on Windows only."))
    }
    pub fn cancel_io(_: usize) {}
    pub fn create_private_dir(_: &std::path::Path) -> std::io::Result<()> { Err(std::io::Error::other("Windows only.")) }
    pub fn in_kill_on_close_job() -> bool { true }
    pub fn process_image(_: u32) -> Option<std::path::PathBuf> { None }
    pub fn raw(_: &File) -> usize { 0 }
}

pub use win::{create_private_dir, in_kill_on_close_job, process_image};

pub fn open_pipe(server_name: &str, expected_pid: u32) -> Result<File, IpcError> {
    if !valid_server_name(server_name) {
        return Err(IpcError::new("invalid", "Not an Awake Launcher integration endpoint."));
    }
    connect(server_name, expected_pid)
}

/// Open `\.\pipe\<server_name>` and verify it is served by `expected_pid` running as this user.
/// Callers check the name against their own allowlist first.
pub fn connect(server_name: &str, expected_pid: u32) -> Result<File, IpcError> {
    let path = format!(r"\\.\pipe\{server_name}");
    let file = OpenOptions::new().read(true).write(true).open(&path).map_err(|e| match e.raw_os_error() {
        Some(231) => IpcError::new("busy", "The Launcher is serving the maximum number of clients."),
        Some(2) => IpcError::new("not-running", "The Launcher endpoint is not listening. Awake Launcher may have closed."),
        _ => IpcError::new("io", format!("Could not open the Launcher pipe: {e}")),
    })?;
    win::verify_server(&file, expected_pid)?;
    Ok(file)
}

#[tauri::command]
pub fn ipc_open(state: tauri::State<'_, Connections>, server_name: String, pid: String) -> Result<u32, IpcError> {
    let pid: u32 = pid.parse().map_err(|_| IpcError::new("invalid", "Descriptor pid is not a number."))?;
    Ok(register(&state, open_pipe(&server_name, pid)?))
}

pub fn register(state: &Connections, file: File) -> u32 {
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let raw = win::raw(&file);
    state.map.lock().unwrap().insert(id, Arc::new(Conn { file: Mutex::new(file), raw }));
    id
}

#[tauri::command]
pub async fn ipc_request(state: tauri::State<'_, Connections>, id: u32, body: String, timeout_ms: u64) -> Result<String, IpcError> {
    let conn = state.map.lock().unwrap().get(&id).cloned().ok_or_else(|| IpcError::new("closed", "Connection is not open."))?;
    let frame = encode_frame(body.as_bytes())?;
    let (tx, rx) = mpsc::channel();
    let worker = conn.clone();
    std::thread::spawn(move || {
        let mut file = worker.file.lock().unwrap();
        let result = file.write_all(&frame).and_then(|_| file.flush()).map_err(closed).and_then(|_| read_frame(&mut *file));
        let _ = tx.send(result);
    });
    let timeout = Duration::from_millis(timeout_ms.clamp(1_000, 120_000));
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout)).await.map_err(|e| IpcError::new("io", e.to_string()))?;
    let result = match outcome {
        Ok(result) => result,
        Err(_) => {
            win::cancel_io(conn.raw);
            Err(IpcError::new("timeout", "Awake Launcher did not reply in time."))
        }
    };
    match result {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| IpcError::new("frame", "Launcher reply is not UTF-8.")),
        Err(e) => {
            // A failed exchange leaves the stream position unknown: drop the connection.
            state.map.lock().unwrap().remove(&id);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn ipc_close(state: tauri::State<'_, Connections>, id: u32) {
    state.map.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_reject_bad_lengths() {
        let frame = encode_frame(br#"{"a":1}"#).unwrap();
        assert_eq!(&frame[..4], &[0, 0, 0, 7]);
        assert_eq!(read_frame(&mut &frame[..]).unwrap(), br#"{"a":1}"#);
        assert!(encode_frame(b"").is_err());
        assert!(encode_frame(&vec![b' '; MAX_FRAME + 1]).is_err());
        assert_eq!(read_frame(&mut &[0u8, 0, 0, 0][..]).unwrap_err().code, "frame");
        assert_eq!(read_frame(&mut &[0x00u8, 0x10, 0x00, 0x01][..]).unwrap_err().code, "frame");
        assert_eq!(read_frame(&mut &[0u8, 0, 0, 9, b'{'][..]).unwrap_err().code, "closed");
    }

    /// A reader that returns one byte per read, like a fragmented pipe response.
    struct Trickle<'a>(&'a [u8]);
    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() || buf.is_empty() { return Ok(0); }
            buf[0] = self.0[0];
            self.0 = &self.0[1..];
            Ok(1)
        }
    }

    #[test]
    fn fragmented_frames_are_reassembled() {
        let body = br#"{"protocol":{"major":1,"minor":0},"requestId":"r1","result":{}}"#;
        let mut frame = encode_frame(body).unwrap();
        frame.extend(encode_frame(b"{}").unwrap());
        let mut r = Trickle(&frame);
        assert_eq!(read_frame(&mut r).unwrap(), body);
        assert_eq!(read_frame(&mut r).unwrap(), b"{}");
        assert_eq!(read_frame(&mut r).unwrap_err().code, "closed");
    }

    #[test]
    fn only_launcher_pipe_names_are_accepted() {
        assert!(valid_server_name("awake-manager-v1-3f2a9c1e-0000-4000-8000-1234567890ab"));
        assert!(!valid_server_name("awake-manager-v1-"));
        assert!(!valid_server_name("some-other-pipe"));
        assert!(!valid_server_name(r"awake-manager-v1-..\x"));
    }
}
