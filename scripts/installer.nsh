; Shroudly NSIS hooks (electron-builder `nsis.include`).
;
; Installing over a running Shroudly, or uninstalling it, closes the app
; without letting it restore the Windows proxy. If the proxy still points at
; a local Shroudly endpoint, switch it off so the user keeps their internet.
; Also remove Shroudly's login entries, so nothing keeps calling a removed exe.

!include LogicLib.nsh
!include WinVer.nsh
!include WinMessages.nsh

!define SHROUDLY_INET "Software\Microsoft\Windows\CurrentVersion\Internet Settings"

!macro shroudlyResetProxy
  ReadRegStr $0 HKCU "${SHROUDLY_INET}" "ProxyServer"
  StrCpy $1 $0 16
  ReadRegStr $2 HKCU "${SHROUDLY_INET}" "AutoConfigURL"
  StrCpy $3 $2 17
  ${If} $1 == "socks=127.0.0.1:"
  ${OrIf} $3 == "http://127.0.0.1:"
    WriteRegDWORD HKCU "${SHROUDLY_INET}" "ProxyEnable" 0
    ${If} $1 == "socks=127.0.0.1:"
      DeleteRegValue HKCU "${SHROUDLY_INET}" "ProxyServer"
    ${EndIf}
    ${If} $3 == "http://127.0.0.1:"
      DeleteRegValue HKCU "${SHROUDLY_INET}" "AutoConfigURL"
    ${EndIf}
    ReadRegStr $4 HKCU "${SHROUDLY_INET}" "ProxyOverride"
    ${If} $4 == "<local>;127.*;10.*;172.16.*;192.168.*;localhost"
      DeleteRegValue HKCU "${SHROUDLY_INET}" "ProxyOverride"
    ${EndIf}
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "ShroudlyProxyRestore"
!macroend

; Discord app mode points the Discord app's updater at Shroudly (one line in
; Discord's settings.json). Take our line out, so Discord keeps working once
; Shroudly is gone. Only our own loopback value is removed; written without a
; byte-order mark, which Discord's JSON reader would reject.
!macro shroudlyDiscordCleanup
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "foreach ($$d in 'discord','discordptb','discordcanary','discorddevelopment') { $$f = Join-Path $$env:APPDATA ($$d + '\settings.json'); if (Test-Path -LiteralPath $$f) { try { $$j = [IO.File]::ReadAllText($$f) | ConvertFrom-Json; if ([string]$$j.NEW_UPDATE_ENDPOINT -match '^http://127\.0\.0\.1:\d+/$$') { $$j.PSObject.Properties.Remove('NEW_UPDATE_ENDPOINT'); [IO.File]::WriteAllText($$f, ($$j | ConvertTo-Json -Depth 32)) } } catch {} } }"`
  Pop $0
!macroend

; Games and apps mode puts HTTPS_PROXY in the user's environment, pointing at
; Shroudly (electron/app-env.js). With Shroudly gone it would point at nothing,
; so take it out. Ours only: SHROUDLY_APP_PROXY holds the value we wrote, and a
; proxy the user set themselves is left alone. Then tell Explorer, so programs
; started from now on no longer get it.
!macro shroudlyAppEnvCleanup
  ReadRegStr $0 HKCU "Environment" "SHROUDLY_APP_PROXY"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "Environment" "HTTPS_PROXY"
    ${If} $1 == $0
      DeleteRegValue HKCU "Environment" "HTTPS_PROXY"
      ReadRegStr $1 HKCU "Environment" "NO_PROXY"
      ${If} $1 == "localhost,127.0.0.1,::1,.local,.localhost,.lan,.internal,.home.arpa,.home,.fritz.box,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10"
        DeleteRegValue HKCU "Environment" "NO_PROXY"
      ${EndIf}
    ${EndIf}
    DeleteRegValue HKCU "Environment" "SHROUDLY_APP_PROXY"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "ShroudlyAppEnvRestore"
!macroend

; The installer crashed on some first installs: an access violation in
; NSIS's System.dll (offset 0x1581), after which it exits having installed
; nothing — about one fresh install in five on Windows 11 x64, and in 2.4.2's
; installer as well. The cause is electron-builder's per-user folder lookup:
; it asks Windows for the user's Programs folder and then copies a fixed 2 KB
; out of the much shorter string Windows returned, which faults whenever that
; string sits at the end of a memory page. The lookup only runs when no install
; location is recorded yet, so on a first install preInit records the same
; folder Windows would have returned, and the lookup is skipped. Tested: 3 of
; 15 plain first installs crashed, 0 of 15 with the location recorded.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    !insertmacro check64BitAndSetRegView
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ; Only on a first install, where the per-user mode is chosen anyway; an
    ; existing installation, per user or per machine, decides as before.
    ${If} $0 == ""
    ${AndIf} $1 == ""
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}
  !endif
!macroend

; "Is Shroudly running?" for the installer and the uninstaller. electron-
; builder's version starts by reading the installer's own process details
; with GetProcessInfo, raw System::Call code of the same kind (it calls a
; kernel32 function that does not exist on desktop Windows and passes a
; pointer where a length belongs). The installer is not named Shroudly.exe,
; so that step is not needed: this does the same job with tasklist and
; taskkill only — ask the app to close, force it if it does not, and ask the
; user if even that fails.
!macro shroudlyFindApp _OUT
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
  !endif
  Pop ${_OUT}
!macroend

!macro shroudlyKillApp _FORCE
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill ${_FORCE} /im "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill ${_FORCE} /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
  !endif
  Pop $R0
!macroend

!macro customCheckAppRunning
  !insertmacro shroudlyFindApp $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK shroudlyStop
      Quit
    ${endIf}
    shroudlyStop:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`
    !insertmacro shroudlyKillApp ""
    Sleep 300
    StrCpy $R1 0
    shroudlyLoop:
      IntOp $R1 $R1 + 1
      !insertmacro shroudlyFindApp $R0
      ${if} $R0 == 0
        Sleep 1000
        !insertmacro shroudlyKillApp "/f"
        !insertmacro shroudlyFindApp $R0
        ${if} $R0 == 0
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Sleep 2000
          ${if} $R1 > 1
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY shroudlyLoop
            Quit
          ${endIf}
          Goto shroudlyLoop
        ${endIf}
      ${endIf}
  ${endIf}
!macroend

!macro customInit
  ; Electron 43 does not run on Windows 8.1 or earlier. Without this the
  ; installer would succeed and the app would then fail to start with nothing
  ; to explain why, so say it here instead and stop.
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP \
      "Shroudly needs Windows 10 or later.$\r$\n$\r$\n\
Shroudly, Windows 10 veya daha yenisini gerektirir."
    Abort
  ${EndIf}
  !insertmacro shroudlyResetProxy
  !insertmacro shroudlyAppEnvCleanup
!macroend

!macro customUnInstall
  !insertmacro shroudlyResetProxy
  !insertmacro shroudlyAppEnvCleanup
  ; An update also runs the old uninstaller: keep the user's auto-start then.
  ${ifNot} ${isUpdated}
    !insertmacro shroudlyDiscordCleanup
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Shroudly"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Shroudly"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "me.codeshare.shroudly"
  ${endIf}
!macroend
