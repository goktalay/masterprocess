; Master Process - installer script (Inno Setup 6)
; Built by .github/workflows/release.yml:  ISCC /DMyAppVersion=<version> setup.iss
; Input : publish\setup\   (dotnet publish, self-contained win-x64, apphost renamed to "Master Process.exe")
; Output: dist\Master-Process-Setup-<version>.exe
;
; Master Tool finds the installed app through the uninstall entry: DisplayName must start with
; "Master Process" and the executable must be "Master Process.exe" inside InstallLocation.

#define MyAppName "Master Process"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "Mastertool"
#define MyAppURL "https://mastertool.download/araclar/master-process"
#define MyAppExeName "Master Process.exe"

[Setup]
AppId={{F1E8C5A0-3B2D-4A5E-8C9A-B1D2E5F7A8C3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={autopf}\Mastertool\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=LICENSE.txt
OutputDir=dist
OutputBaseFilename=Master-Process-Setup-{#MyAppVersion}
SetupIconFile=ProcessExplorer\Resources\icon.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "publish\setup\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
