; Shroudly NSIS hooks (electron-builder `nsis.include`).
;
; Installing over a running Shroudly, or uninstalling it, closes the app
; without letting it restore the Windows proxy. If the proxy still points at
; a local Shroudly endpoint, switch it off so the user keeps their internet.
; Also remove Shroudly's login entries, so nothing keeps calling a removed exe.
;
; Shroudly sets only the PAC address (AutoConfigURL) now; 2.5.4 and earlier
; also set a manual SOCKS proxy (ProxyServer "socks=127.0.0.1:<port>") and
; switched it on. Both are recognised. ProxyEnable is switched off only along
; with that manual proxy: with the PAC alone it is the user's own setting.

!include LogicLib.nsh
!include WinMessages.nsh

!define SHROUDLY_INET "Software\Microsoft\Windows\CurrentVersion\Internet Settings"

!macro shroudlyResetProxy
  ReadRegStr $0 HKCU "${SHROUDLY_INET}" "ProxyServer"
  StrCpy $1 $0 16
  ReadRegStr $2 HKCU "${SHROUDLY_INET}" "AutoConfigURL"
  StrCpy $3 $2 17
  StrCpy $5 $2 "" -10
  ${If} $1 == "socks=127.0.0.1:"
    WriteRegDWORD HKCU "${SHROUDLY_INET}" "ProxyEnable" 0
    DeleteRegValue HKCU "${SHROUDLY_INET}" "ProxyServer"
    ReadRegStr $4 HKCU "${SHROUDLY_INET}" "ProxyOverride"
    ${If} $4 == "<local>;127.*;10.*;172.16.*;192.168.*;localhost"
      DeleteRegValue HKCU "${SHROUDLY_INET}" "ProxyOverride"
    ${EndIf}
  ${EndIf}
  ; Ours is http://127.0.0.1:<port>/proxy.pac; another local tool's PAC stays.
  ${If} $3 == "http://127.0.0.1:"
  ${AndIf} $5 == "/proxy.pac"
    DeleteRegValue HKCU "${SHROUDLY_INET}" "AutoConfigURL"
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "ShroudlyProxyRestore"
!macroend

; Discord app mode points the Discord app's updater at Shroudly (one line in
; Discord's settings.json). Take our line out, so Discord keeps working once
; Shroudly is gone. Only our own loopback value is removed; written without a
; byte-order mark, which Discord's JSON reader would reject. PowerShell is
; started only when a Discord settings file is there: an uninstaller that
; starts PowerShell for nothing is what antivirus programs stop, and the
; next install then fails on it. The same APPDATA as PowerShell's, read from
; the environment: for an install for all users, NSIS's $APPDATA is not the
; user's.
!macro shroudlyDiscordCleanup
  ReadEnvStr $1 APPDATA
  ${If} ${FileExists} "$1\discord\settings.json"
  ${OrIf} ${FileExists} "$1\discordptb\settings.json"
  ${OrIf} ${FileExists} "$1\discordcanary\settings.json"
  ${OrIf} ${FileExists} "$1\discorddevelopment\settings.json"
    nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "foreach ($$d in 'discord','discordptb','discordcanary','discorddevelopment') { $$f = Join-Path $$env:APPDATA ($$d + '\settings.json'); if (Test-Path -LiteralPath $$f) { try { $$j = [IO.File]::ReadAllText($$f) | ConvertFrom-Json; if ([string]$$j.NEW_UPDATE_ENDPOINT -match '^http://127\.0\.0\.1:\d+/$$') { $$j.PSObject.Properties.Remove('NEW_UPDATE_ENDPOINT'); [IO.File]::WriteAllText($$f, ($$j | ConvertTo-Json -Depth 32)) } } catch {} } }"`
    Pop $0
  ${EndIf}
!macroend

; Microsoft Store apps reach Shroudly through loopback exemptions it added
; (electron/store-apps.js), listed under HKCU\Software\Shroudly\LoopbackExemptions,
; one value per SID (before: the LoopbackExempt value, the SIDs joined by ';';
; read too). Take out those, and only those: an exemption the user had is not
; in the list. PowerShell reads the list, not NSIS, whose strings end at 8192
; characters (a long list would read as nothing); with no SIDs in it, it does
; nothing and nothing is asked. Each entry must be an app container SID
; before it reaches CheckNetIsolation, which runs elevated (one
; administrator prompt) from a script that reads them from a file; the file's
; path reaches that script as base64, never inside quotes, so any character
; in TEMP works, and the script deletes it once read. The PowerShell started
; from here is the 32-bit one, so that script reaches the 64-bit tool through
; Sysnative. The list goes once it ran.
;
; PowerShell is started only when there is a list: most people never had a
; Store app exempted, and an uninstaller that starts an elevating PowerShell
; for nothing is what antivirus programs stop. NSIS looks only at the names
; of the values (EnumRegValue), never at the data, so a long list is still
; seen; the old single value is found by its name too. An empty list key is
; simply removed.
!macro shroudlyLoopbackCleanup
  ClearErrors
  EnumRegValue $0 HKCU "Software\Shroudly\LoopbackExemptions" 0
  ${If} $0 == ""
    StrCpy $1 0
    ${Do}
      EnumRegValue $2 HKCU "Software\Shroudly" $1
      ${If} $2 == "LoopbackExempt"
        StrCpy $0 $2
        ${ExitDo}
      ${EndIf}
      IntOp $1 $1 + 1
    ${LoopUntil} $2 == ""
  ${EndIf}
  ClearErrors
  ${If} $0 == ""
    DeleteRegKey /ifempty HKCU "Software\Shroudly\LoopbackExemptions"
  ${Else}
    nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$k = 'HKCU:\Software\Shroudly'; $$r = Join-Path $$k 'LoopbackExemptions'; $$v = [string](Get-ItemProperty -LiteralPath $$k -Name LoopbackExempt -ErrorAction SilentlyContinue).LoopbackExempt; $$o = Get-Item -LiteralPath $$r -ErrorAction SilentlyContinue; $$ids = @(@($$v -split ';') + @(if ($$o) { $$o.GetValueNames() }) | Where-Object { $$_ -match '^S-1-15-2(-\d{1,10}){7}$$' } | Select-Object -Unique); $$done = $$true; if ($$ids.Count) { $$done = $$false; $$f = Join-Path ([IO.Path]::GetTempPath()) ('shroudly-lb-' + [guid]::NewGuid().ToString('N') + '.txt'); [IO.File]::WriteAllLines($$f, [string[]]$$ids); $$b = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($$f)); $$c = '$$f = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(''' + $$b + ''')); $$l = [IO.File]::ReadAllLines($$f); Remove-Item -LiteralPath $$f -Force -ErrorAction SilentlyContinue; $$n = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { ''Sysnative'' } else { ''System32'' }; $$t = Join-Path $$env:SystemRoot ($$n + ''\CheckNetIsolation.exe''); foreach ($$s in $$l) { if ($$s -match ''^S-1-15-2(-\d{1,10}){7}$$'') { & $$t LoopbackExempt -d (''-p='' + $$s) | Out-Null } }'; $$e = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($$c)); try { Start-Process -FilePath (Join-Path $$env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + $$e) -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop; $$done = $$true } catch {}; Remove-Item -LiteralPath $$f -Force -ErrorAction SilentlyContinue }; if ($$done) { Remove-ItemProperty -LiteralPath $$k -Name LoopbackExempt -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $$r -Recurse -Force -ErrorAction SilentlyContinue }; exit 0"`
    Pop $0
  ${EndIf}
!macroend

; Games and apps mode puts HTTPS_PROXY in the user's environment, pointing at
; Shroudly (electron/app-env.js): the session's part of it (Volatile
; Environment, emptied by Windows at logoff), and up to 2.5.12 the part that is
; kept (Environment). With Shroudly gone it would point at nothing, so take it
; out of both. Ours only: SHROUDLY_APP_PROXY holds the value we wrote, and a
; proxy the user set themselves is left alone. Then tell Explorer, so programs
; started from now on no longer get it. $2 says whether anything was removed.
!macro shroudlyAppEnvCleanupIn _KEY
  ReadRegStr $0 HKCU "${_KEY}" "SHROUDLY_APP_PROXY"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "${_KEY}" "HTTPS_PROXY"
    ${If} $1 == $0
      DeleteRegValue HKCU "${_KEY}" "HTTPS_PROXY"
      ReadRegStr $1 HKCU "${_KEY}" "NO_PROXY"
      ${If} $1 == "localhost,127.0.0.1,::1,.local,.localhost,.lan,.internal,.home.arpa,.home,.fritz.box,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10"
        DeleteRegValue HKCU "${_KEY}" "NO_PROXY"
      ${EndIf}
    ${EndIf}
    DeleteRegValue HKCU "${_KEY}" "SHROUDLY_APP_PROXY"
    StrCpy $2 "1"
  ${EndIf}
  ; Node.js's switch for reading HTTPS_PROXY, when Shroudly set it
  ; (SHROUDLY_NODE_PROXY says so); a value of the user's own is left alone.
  ReadRegStr $0 HKCU "${_KEY}" "SHROUDLY_NODE_PROXY"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "${_KEY}" "NODE_USE_ENV_PROXY"
    ${If} $1 == "1"
      DeleteRegValue HKCU "${_KEY}" "NODE_USE_ENV_PROXY"
    ${EndIf}
    DeleteRegValue HKCU "${_KEY}" "SHROUDLY_NODE_PROXY"
    StrCpy $2 "1"
  ${EndIf}
!macroend

!macro shroudlyAppEnvCleanup
  StrCpy $2 ""
  !insertmacro shroudlyAppEnvCleanupIn "Environment"
  !insertmacro shroudlyAppEnvCleanupIn "Volatile Environment"
  ${If} $2 != ""
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "ShroudlyAppEnvRestore"
!macroend

; Games and apps mode also points the links of Roblox's programs (roblox-
; player:, roblox-studio:, ...) at Shroudly, which starts the program with the
; setting (electron/link-handlers.js). With Shroudly gone they would open
; nothing, so put each back as it was: listed under
; HKCU\Software\Shroudly\LinkHandlers (one value per class, its data where the
; entry came from), and only while the entry is still ours (its command is the
; one we wrote): one its program wrote again since stays. "user": the original
; command goes back, with its type ("user-expand": REG_EXPAND_SZ); "machine":
; the user had no entry, ours is removed and the machine's applies again. Our
; values beside it go in every case. _ID keeps the labels apart where it is
; used twice in one script.
!macro shroudlyLinkCleanup _ID
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R5 0
  shroudlyLinkNext${_ID}:
    EnumRegValue $R6 HKCU "Software\Shroudly\LinkHandlers" $R5
    StrCmp $R6 "" shroudlyLinkDone${_ID}
    IntOp $R5 $R5 + 1
    ReadRegStr $R7 HKCU "Software\Classes\$R6\shell\open\command" ""
    ReadRegStr $R8 HKCU "Software\Classes\$R6\shell\open\command" "ShroudlyCommand"
    ReadRegStr $R9 HKCU "Software\Classes\$R6\shell\open\command" "ShroudlyFrom"
    ${If} $R8 != ""
    ${AndIf} $R7 == $R8
      ${If} $R9 == "machine"
        DeleteRegKey HKCU "Software\Classes\$R6"
        Goto shroudlyLinkNext${_ID}
      ${EndIf}
      ReadRegStr $R7 HKCU "Software\Classes\$R6\shell\open\command" "ShroudlyOriginal"
      ${If} $R7 != ""
        ${If} $R9 == "user-expand"
          WriteRegExpandStr HKCU "Software\Classes\$R6\shell\open\command" "" $R7
        ${Else}
          WriteRegStr HKCU "Software\Classes\$R6\shell\open\command" "" $R7
        ${EndIf}
      ${EndIf}
    ${EndIf}
    DeleteRegValue HKCU "Software\Classes\$R6\shell\open\command" "ShroudlyOriginal"
    DeleteRegValue HKCU "Software\Classes\$R6\shell\open\command" "ShroudlyFrom"
    DeleteRegValue HKCU "Software\Classes\$R6\shell\open\command" "ShroudlyCommand"
    Goto shroudlyLinkNext${_ID}
  shroudlyLinkDone${_ID}:
  DeleteRegKey HKCU "Software\Shroudly\LinkHandlers"
  DeleteRegKey /ifempty HKCU "Software\Shroudly"
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
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

; Installing over an older Shroudly first runs that version's uninstaller.
; When it cannot finish (an antivirus stopped it or took one of its files, a
; file it could not move), electron-builder's installer stopped right there
; with "Failed to uninstall old application files. Please try running the
; installer again", on every try, so Shroudly could not be installed again
; at all. Now the new version is installed over the old files instead.
; Nothing of ours is lost: what that uninstaller puts back on an update (the
; proxy, the links, the environment) customInit has put back already.
; Both hooks run inside one electron-builder function: LogicLib only (no
; labels of their own), only $R0 (the old uninstaller's exit code) and the
; error flag (it could not be started at all), and the stack and
; electron-builder's own variables left alone.
!macro shroudlyOldUninstallerFailed _WHICH
  ${If} ${Errors}
    DetailPrint `Previous ${PRODUCT_NAME} (${_WHICH}): its uninstaller could not be started; installing over it.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous ${PRODUCT_NAME} (${_WHICH}): its uninstaller ended with code $R0; installing over it.`
  ${EndIf}
  ClearErrors
!macroend

!macro customUnInstallCheck
  !insertmacro shroudlyOldUninstallerFailed "SHELL_CONTEXT"
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro shroudlyOldUninstallerFailed "HKCU"
!macroend

; The other half, for the updates after this one: this uninstaller is the
; "old" one then. On an update electron-builder's uninstaller moves every
; file out of the way and, at the first it cannot move (an antivirus holding
; it, say), puts them all back and gives up, which is what stopped the
; installer. Here every file that can be moved is moved, to the same place,
; and one that cannot is left for the installer to replace; nothing gives
; up. A program file still running moves like any other, and Shroudly
; itself was closed before this. Then the folder is removed, on an update
; and on a plain uninstall alike, as electron-builder does.
!ifdef BUILD_UNINSTALLER
  Function un.shroudlyMoveOut
    Exch $R0
    Push $R1
    Push $R2
    FindFirst $R1 $R2 "$INSTDIR$R0\*.*"
    ${DoWhile} $R2 != ""
      ${If} $R2 != "."
      ${AndIf} $R2 != ".."
        ${If} ${FileExists} "$INSTDIR$R0\$R2\*.*"
          CreateDirectory "$PLUGINSDIR\old-install$R0\$R2"
          Push "$R0\$R2"
          Call un.shroudlyMoveOut
        ${Else}
          ClearErrors
          Rename "$INSTDIR$R0\$R2" "$PLUGINSDIR\old-install$R0\$R2"
          ${If} ${Errors}
            DetailPrint `File is busy, left for the installer to replace: $INSTDIR$R0\$R2`
          ${EndIf}
        ${EndIf}
      ${EndIf}
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd
!endif

!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.shroudlyMoveOut
  ${endif}
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend

; New installs are for this user only, in their own folder, with no question
; about it. electron-builder's page asked "Anyone who uses this computer, or
; only for me?", a question nobody new to this can answer, and "Anyone"
; needs an administrator: then so did every update afterwards (a prompt a
; standard account cannot answer, coming up by itself), and the uninstaller
; tidied the administrator's settings instead of the user's. A copy that is
; already installed for everyone, and only such a copy, is updated where it
; is, as before (no second copy beside it, #57). The uninstaller's page,
; which asks which copy to remove when there are two, stays as it is.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
  ${If} $hasPerMachineInstallation == "1"
  ${AndIf} $hasPerUserInstallation != "1"
    StrCpy $isForceMachineInstall "1"
  ${Else}
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
  !endif
!macroend

; Shroudly's own update of a copy installed for everyone (silent, with
; --updated) needs an administrator's permission. electron-builder asks for
; it in its install section and, when it is refused or cannot be asked,
; quits there: Shroudly had already closed for the update, did not come
; back, and protection stayed off. It is asked here instead, the same way,
; before anything is touched; the elevated copy then installs and starts the
; new version. Refused, or Windows could not ask (an account whose requests
; are turned down): nothing is installed, and the Shroudly that was there is
; started again once it has closed, with a note of why. It says that once
; and does not install this version by itself again (electron/updater.js,
; _readFailedNote; the steps are its INSTALL_STEPS). No message box: the
; user has just answered Windows' own.
!macro shroudlyElevateUpdate
  !ifndef INSTALL_MODE_PER_ALL_USERS
  !ifndef ONE_CLICK
  ${If} ${isUpdated}
  ${AndIf} ${Silent}
  ${AndIf} $hasPerMachineInstallation == "1"
  ${AndIfNot} ${UAC_IsInnerInstance}
  ${AndIfNot} ${UAC_IsAdmin}
    !insertmacro UAC_RunElevated
    StrCpy $R2 "elevation"
    ${If} $0 == 1223
      StrCpy $R2 "permission"
    ${ElseIf} $0 == 0
    ${AndIf} $1 == 1
      Quit
    ${ElseIf} $0 == 0
    ${AndIf} $1 == 3
      ; a name and password given that are not an administrator's
      StrCpy $R2 "permission"
    ${EndIf}
    StrCpy $R3 0
    ${Do}
      !insertmacro shroudlyFindApp $R0
      ${If} $R0 != 0
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $R3 $R3 + 1
    ${LoopUntil} $R3 >= 20
    ReadEnvStr $R1 APPDATA
    ${If} $R1 != ""
      CreateDirectory "$R1\${PRODUCT_NAME}\update"
      ClearErrors
      FileOpen $R0 "$R1\${PRODUCT_NAME}\update\failed" w
      ${IfNot} ${Errors}
        FileWrite $R0 "${VERSION} $R2"
        FileClose $R0
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --update-failed'
    ${EndIf}
    Quit
  ${EndIf}
  !endif
  !endif
!macroend

!macro customInit
  ; Electron 43 does not run on Windows 8.1 or earlier. Without this the
  ; installer would succeed and the app would then fail to start with nothing
  ; to explain why, so say it here instead and stop. The version comes from
  ; the registry, not from Windows' version call: a compatibility setting on
  ; the installer (its Compatibility tab, or the "recommended settings"
  ; Windows can offer after an install that failed) makes that call report an
  ; older Windows, and the installer would then stop here on every run. The
  ; value is there on Windows 10 and 11 and missing on 8.1 and older, which
  ; reads as 0.
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentMajorVersionNumber"
  ClearErrors
  ${If} $0 < 10
    MessageBox MB_OK|MB_ICONSTOP \
      "Shroudly needs Windows 10 or later.$\r$\n$\r$\n\
Shroudly, Windows 10 veya daha yenisini gerektirir."
    Abort
  ${EndIf}
  !insertmacro shroudlyResetProxy
  !insertmacro shroudlyLinkCleanup "i"
  !insertmacro shroudlyAppEnvCleanup
  !insertmacro shroudlyElevateUpdate
!macroend

; What only Shroudly's downloads kept, 100 MB and more: electron-updater's
; last installer (%LOCALAPPDATA%\shroudly-updater), the ad and tracker list,
; Roblox installers fetched for Games and apps mode, an update's leftovers.
; Each is fetched again when needed. The settings, the logs and the Discord
; files moved aside (with the note on how to put them back) stay, so a
; reinstall finds everything as it was. The same folders as Shroudly's, read
; from the environment: for an install for all users, NSIS's are not the
; user's.
!macro shroudlyCacheCleanup
  ReadEnvStr $1 LOCALAPPDATA
  ${If} $1 != ""
    RMDir /r "$1\shroudly-updater"
  ${EndIf}
  ReadEnvStr $1 APPDATA
  ${If} $1 != ""
    Delete "$1\${PRODUCT_NAME}\adblock-list.*"
    RMDir /r "$1\${PRODUCT_NAME}\roblox"
    RMDir /r "$1\${PRODUCT_NAME}\update"
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro shroudlyResetProxy
  !insertmacro shroudlyLinkCleanup "u"
  !insertmacro shroudlyAppEnvCleanup
  ; An update also runs the old uninstaller: keep the user's auto-start then.
  ${ifNot} ${isUpdated}
    !insertmacro shroudlyDiscordCleanup
    !insertmacro shroudlyLoopbackCleanup
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Shroudly"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Shroudly"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "me.codeshare.shroudly"
    !insertmacro shroudlyCacheCleanup
  ${endIf}
!macroend
