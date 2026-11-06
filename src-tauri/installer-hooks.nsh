; Awake Modpack Manager installer hooks (Tauri 2 NSIS).
;
; The native helper (core-host\windows-x64\awake-core-host.exe) can keep running briefly after the
; Manager window closes, to finish or recover accepted work. Windows locks a running helper's files,
; and an upgrade must never leave old and new helper files mixed, so install and uninstall wait for
; it to exit (it exits by itself once idle). The installer never kills it.
;
; User data is never removed here: projects and helper data live in
; %LOCALAPPDATA%\AwakeModpackManager, outside the folders the uninstaller deletes.

!macro AWAKE_WAIT_FOR_HELPER
  awake_helper_check_${__LINE__}:
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq awake-core-host.exe" /NH | "$SYSDIR\find.exe" /I "awake-core-host.exe""'
  Pop $0
  Pop $1
  ${If} $0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The Awake Modpack Manager helper is still finishing work in the background.$\r$\n$\r$\nClose Awake Modpack Manager, wait a minute for the helper to exit by itself, then choose Retry." /SD IDCANCEL IDRETRY awake_helper_check_${__LINE__}
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AWAKE_WAIT_FOR_HELPER
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AWAKE_WAIT_FOR_HELPER
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Your modpack projects in $LOCALAPPDATA\AwakeModpackManager were kept."
!macroend
