; Awake Modpack Manager installer hooks (Tauri 2 NSIS).
;
; The native helper (core-host\windows-x64\awake-core-host.exe) can keep running briefly after the
; Manager window closes, to finish or recover accepted work. Windows locks a running helper's files,
; and an upgrade must never leave old and new helper files mixed, so install and uninstall wait for
; it to exit (it exits by itself once idle). The installer never kills it.
;
; User data is never removed here: projects and helper data live in
; %LOCALAPPDATA%\AwakeModpackManager, outside the folders the uninstaller deletes.

; Only this installation's helper matters: a running executable can't be opened for writing, so a
; successful open (no bytes written) means it is not running. Helpers of other installs are ignored.
!macro AWAKE_WAIT_FOR_HELPER
  StrCpy $1 0
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\core-host\windows-x64\awake-core-host.exe"
      ${Break}
    ${EndIf}
    ClearErrors
    FileOpen $0 "$INSTDIR\core-host\windows-x64\awake-core-host.exe" a
    ${IfNot} ${Errors}
      FileClose $0
      ${Break}
    ${EndIf}
    ; It exits by itself once idle: give it a minute and a half before asking anything.
    ${If} $1 = 0
      DetailPrint "Waiting for the Awake Modpack Manager helper to finish. This can take up to 90 seconds."
    ${EndIf}
    ${If} $1 < 90
      IntOp $1 $1 + 1
      Sleep 1000
      ${Continue}
    ${EndIf}
    ; Retry checks again; Cancel (and the silent default) stops without touching any file.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION|MB_TOPMOST|MB_SETFOREGROUND "The Awake Modpack Manager helper is still finishing work in the background.$\r$\n$\r$\nClose Awake Modpack Manager, wait a minute for the helper to exit by itself, then choose Retry.$\r$\n$\r$\nIf it keeps running, open Awake Modpack Manager once (it cancels changes you reviewed but never applied), close it, and wait a minute." /SD IDCANCEL IDRETRY +2
    Abort
  ${Loop}
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
