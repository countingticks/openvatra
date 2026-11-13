; A detached core keeps core.exe open, and the shell no longer stops it on its own exit, so an update or an
; uninstall would hit a locked file. Both hooks ask a running core to stop first. The exit code is ignored: 1 means
; it is still running, and the installer's own file-in-use handling then reports it.

!macro stopCore
  ReadEnvStr $0 APPDATA
  IfFileExists "$INSTDIR\resources\core\core.exe" 0 +3
    nsExec::Exec '"$INSTDIR\resources\core\core.exe" --stop --data-dir "$0\OpenVatra\data"'
    Pop $1
!macroend

!macro customInit
  !insertmacro stopCore
!macroend

!macro customUnInit
  !insertmacro stopCore
!macroend
