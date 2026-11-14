; Saved as UTF-8 with a byte order mark: NSIS reads a file without one in the old Windows code page, which garbles the ⓘ.
; Aeneas hub for Windows, as one installer (Aeneas-Hub-Setup.exe). Built on any system with NSIS 3:
;   bash deploy/windows/installer/build.sh 1.0.2
; It carries deploy/install.ps1 and runs it with the choices made on its pages. That script downloads and checks
; everything else against published SHA-256 sums: Node, MinGit (when the PC has no git), the app, Ollama, Tor, private
; search, and Tailscale when the PC does not have it. Run again, it updates the hub. Settings, Apps, Aeneas hub
; uninstalls it and keeps the data and keys.
;
; It runs as the user (not elevated): the hub, its data and its boot task belong to that user. The one step that
; needs an administrator (registering the boot task, and installing Tailscale or a firewall rule for the home network
; when those are chosen) asks Windows for permission itself.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef OUTDIR
  !define OUTDIR "."
!endif

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AeneasHub"
!define UNINSTALLER "Uninstall Aeneas hub.exe"

Name "Aeneas hub"
OutFile "${OUTDIR}/Aeneas-Hub-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\AeneasHub"
BrandingText "Aeneas hub ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Aeneas hub"
VIAddVersionKey "FileDescription" "Aeneas hub installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "gnomecannon"
VIAddVersionKey "LegalCopyright" "AGPL-3.0-only"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

!define MUI_ICON "${__FILEDIR__}\..\..\..\web\src-tauri\icons\icon.ico"
!define MUI_UNICON "${__FILEDIR__}\..\..\..\web\src-tauri\icons\icon.ico"
!define MUI_ABORTWARNING

Var ModelsDir
; How devices reach the hub: direct (iroh), tailscale or home. The page and its controls.
Var Link
Var LinkDialog
Var RDirect
Var RTailscale
Var RHome
; The installer is a 32-bit program: Windows would start the 32-bit PowerShell for it, which sees Program Files (x86).
; Sysnative is the 64-bit system folder as a 32-bit program reaches it.
Var PS

!define MUI_WELCOMEPAGE_TITLE "Make this PC your Aeneas hub"
!define MUI_WELCOMEPAGE_TEXT "The hub keeps your notes, tasks, reminders and the assistant's memory, and runs the AI model on this PC's graphics card. Your iPhone, iPad and Mac connect to it privately; the next pages ask how, and where the model goes.$\r$\n$\r$\nThis installer downloads about 2 GB (the hub, Ollama for the AI model, Tor and private search), each checked against its published checksum. It takes about 15 minutes.$\r$\n$\r$\nWindows asks once for permission (an administrator). The model itself is chosen and downloaded on the Welcome page at the end."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${__FILEDIR__}\..\..\..\LICENSE"

Page custom LinkPage LinkPageLeave

!define MUI_PAGE_HEADER_TEXT "Where the AI model is kept"
!define MUI_PAGE_HEADER_SUBTEXT "A model takes 1.5 to 19 GB, depending on the graphics card."
!define MUI_DIRECTORYPAGE_TEXT_TOP "The model is kept in this folder. A fast SSD (NVMe) loads a large model in about 5 to 10 seconds; a hard drive takes about 2 minutes, each time the assistant starts after 5 quiet minutes. How fast it answers once loaded is the same everywhere.$\r$\n$\r$\nA network drive cannot hold it: the hub runs before anyone logs in, and cannot reach one then."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Folder for the AI model"
!define MUI_DIRECTORYPAGE_VARIABLE $ModelsDir
!insertmacro MUI_PAGE_DIRECTORY

ShowInstDetails show
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "The hub is running"
!define MUI_FINISHPAGE_TEXT "It starts by itself whenever this PC starts, before anyone logs in, and keeps the PC awake while it is on power.$\r$\n$\r$\nThe Welcome page opened in your browser: choose your modules, download the model it suggests, and save the key to your backups. Then install Aeneas on your iPhone or Mac, press Make a pairing code, and scan it."
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
ShowUninstDetails show
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; EA_ROOT (a test install elsewhere) moves the hub's folder; the models folder defaults to the one chosen last time.
Function .onInit
  ; Sysnative cannot be looked at like a folder (it is a name Windows resolves for 32-bit programs), so it is chosen
  ; by the system being 64-bit, not by finding the file.
  ${If} ${RunningX64}
    StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $PS "powershell.exe"
  ${EndIf}
  ReadEnvStr $0 EA_ROOT
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  ReadEnvStr $ModelsDir EA_MODELS_DIR
  ${If} $ModelsDir == ""
  ${AndIf} ${FileExists} "$INSTDIR\config\hub.env"
    ClearErrors
    FileOpen $1 "$INSTDIR\config\hub.env" r
    ${Do}
      FileRead $1 $2
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $3 $2 14
      ${If} $3 == "EA_MODELS_DIR="
        StrCpy $ModelsDir $2 "" 14
        ; FileRead keeps the line ending: taken off.
        ${Do}
          StrCpy $3 $ModelsDir 1 -1
          ${If} $3 == "$\n"
          ${OrIf} $3 == "$\r"
            StrCpy $ModelsDir $ModelsDir -1
          ${Else}
            ${ExitDo}
          ${EndIf}
        ${Loop}
      ${EndIf}
    ${Loop}
    FileClose $1
  ${EndIf}
  ${If} $ModelsDir == ""
    StrCpy $ModelsDir "$INSTDIR\models"
  ${EndIf}
  ; The choice made last time (EA_LINK in hub.env), else Direct link.
  ReadEnvStr $Link EA_LINK
  ${If} $Link == ""
  ${AndIf} ${FileExists} "$INSTDIR\config\hub.env"
    ClearErrors
    FileOpen $1 "$INSTDIR\config\hub.env" r
    ${Do}
      FileRead $1 $2
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $3 $2 8
      ${If} $3 == "EA_LINK="
        StrCpy $3 $2 4 8
        ${If} $3 == "dire"
          StrCpy $Link "direct"
        ${ElseIf} $3 == "tail"
          StrCpy $Link "tailscale"
        ${ElseIf} $3 == "home"
          StrCpy $Link "home"
        ${EndIf}
      ${EndIf}
    ${Loop}
    FileClose $1
  ${EndIf}
  ${If} $Link != "tailscale"
  ${AndIf} $Link != "home"
    StrCpy $Link "direct"
  ${EndIf}
FunctionEnd

!define COMPARE_URL "https://github.com/gnomecannon/aeneas/blob/main/docs/connections.md"

; One choice: a radio button, its line, and an info link that opens a short note (and offers the full comparison).
!macro LinkChoice VAR Y Y2 TITLE LINE INFOFN
  ${NSD_CreateRadioButton} 0 ${Y} 255u 11u "${TITLE}"
  Pop ${VAR}
  ${NSD_CreateLabel} 12u ${Y2} 245u 18u "${LINE}"
  Pop $0
  ${NSD_CreateLink} 262u ${Y} 38u 11u "ⓘ  About"
  Pop $0
  ${NSD_OnClick} $0 ${INFOFN}
!macroend

Function LinkPage
  !insertmacro MUI_HEADER_TEXT "How will your phone and computers reach this hub?" "You can change this later in Settings."
  nsDialogs::Create 1018
  Pop $LinkDialog
  ${If} $LinkDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "Your hub runs on this computer. Your other devices need a private way to reach it, at home and when you're out."
  Pop $0
  !insertmacro LinkChoice $RDirect 24u 36u "Direct link (recommended, uses iroh)" "Scan a QR code and you're done. No account. Works at home and away." InfoDirect
  !insertmacro LinkChoice $RTailscale 58u 70u "Tailscale" "For people who already use Tailscale. Needs a free Tailscale account and a sign-in on each device." InfoTailscale
  !insertmacro LinkChoice $RHome 92u 104u "Home Wi-Fi only" "Nothing to sign in to. Your devices reach the hub only on your home network." InfoHome
  ${NSD_CreateLink} 0 128u 100% 11u "Compare all three in detail"
  Pop $0
  ${NSD_OnClick} $0 OpenCompare
  ${If} $Link == "tailscale"
    ${NSD_Check} $RTailscale
  ${ElseIf} $Link == "home"
    ${NSD_Check} $RHome
  ${Else}
    ${NSD_Check} $RDirect
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function LinkPageLeave
  ${NSD_GetState} $RTailscale $0
  ${NSD_GetState} $RHome $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Link "tailscale"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $Link "home"
  ${Else}
    StrCpy $Link "direct"
  ${EndIf}
FunctionEnd

Function OpenCompare
  ExecShell "open" "${COMPARE_URL}"
FunctionEnd

!macro InfoBox TEXT
  MessageBox MB_YESNO|MB_ICONINFORMATION "${TEXT}$\r$\n$\r$\nOpen the full comparison of all three in your browser?" IDNO +2
  ExecShell "open" "${COMPARE_URL}"
!macroend

Function InfoDirect
  !insertmacro InfoBox "Direct link$\r$\n$\r$\nYour devices connect straight to this hub, encrypted end to end, using iroh, open source networking software from the company n0. If a direct path is blocked, traffic passes through a relay that can't read it or pretend to be your hub. Relays are run by n0, free, with no uptime promise. No account: the QR code is the only key, and only devices that scanned it can connect. It needs Aeneas 1.0.3 or newer on each phone and computer."
FunctionEnd

Function InfoTailscale
  !insertmacro InfoBox "Tailscale$\r$\n$\r$\nTailscale builds a private network of your devices. It's mature and widely audited. You need an account (Google, Apple, Microsoft or GitHub). Tailscale keeps a list of your devices and when they're online, and its server decides which devices belong to your network. Devices sign in again every 180 days unless you turn that off. Choose this if you already use Tailscale or want the hub to reach your other machines.$\r$\n$\r$\nThis installer installs Tailscale if this PC doesn't have it, and your browser opens to sign in."
FunctionEnd

Function InfoHome
  !insertmacro InfoBox "Home Wi-Fi only$\r$\n$\r$\nDevices connect over your own network using the hub's own certificate, which the QR code lets them check. Nothing leaves your home. Away from home, the apps can't reach the hub.$\r$\n$\r$\nWindows asks permission to let your home network reach the hub (a firewall rule for this hub only, on private networks)."
FunctionEnd

Section "Aeneas hub" SecHub
  SetOutPath "$PLUGINSDIR"
  File "${__FILEDIR__}\..\..\install.ps1"
  System::Call 'Kernel32::SetEnvironmentVariable(t "EA_INSTALLER", t "1")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "EA_MODELS_DIR", t "$ModelsDir")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "EA_ROOT", t "$INSTDIR")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "EA_LINK", t "$Link")i'
  DetailPrint "Installing the Aeneas hub: about 2 GB of downloads and 15 minutes. Each line below says what it does."
  nsExec::ExecToLog '"$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "The installation stopped: the line above starting with error says why."
    MessageBox MB_ICONSTOP "The installation did not finish. The last lines in the installer window say why; run the installer again once that is fixed (it picks up where it stopped)." /SD IDOK
    Abort
  ${EndIf}
  ; Settings, Apps, Aeneas hub: its uninstaller keeps the data and keys.
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Aeneas hub"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "gnomecannon"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/gnomecannon/aeneas"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${UNINSTALLER}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  ; Sysnative cannot be looked at like a folder (it is a name Windows resolves for 32-bit programs), so it is chosen
  ; by the system being 64-bit, not by finding the file.
  ${If} ${RunningX64}
    StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $PS "powershell.exe"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; deploy\windows\uninstall.ps1 stops the hub, asks Windows for permission to remove the boot task, and removes the
  ; programs and the app; the data, keys and models stay, and it names their folders.
  System::Call 'Kernel32::SetEnvironmentVariable(t "EA_UNINSTALL_YES", t "1")i'
  ${If} ${FileExists} "$INSTDIR\app\deploy\windows\uninstall.ps1"
    nsExec::ExecToLog '"$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\app\deploy\windows\uninstall.ps1"'
    Pop $0
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALLER}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DetailPrint "Kept for you to copy or delete: $INSTDIR\data (your data and backups), $INSTDIR\config (settings and keys) and the models folder."
SectionEnd
