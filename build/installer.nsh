; A detached core keeps core.exe open, and the shell no longer stops it on its own exit, so an update or an
; uninstall would hit a locked file. Both hooks ask a running core to stop first. The exit code is ignored: 1 means
; it is still running, and the installer's own file-in-use handling then reports it.

; $0 and $1 are saved and restored: electron-builder's own .onInit code runs after these hooks.
!macro stopCore
  Push $0
  Push $1
  ReadEnvStr $0 APPDATA
  IfFileExists "$INSTDIR\resources\core\core.exe" 0 +3
    nsExec::Exec '"$INSTDIR\resources\core\core.exe" --stop --data-dir "$0\OpenVatra\data"'
    Pop $1
  Pop $1
  Pop $0
!macroend

!macro customInit
  !insertmacro stopCore
!macroend

!macro customUnInit
  !insertmacro stopCore
!macroend
