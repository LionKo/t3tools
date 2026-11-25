#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MyStageDir
  #define MyStageDir "..\dist\release\_inno_stage"
#endif
#ifndef MyOutputDir
  #define MyOutputDir "..\dist\release"
#endif
#ifndef MyIconFile
  #define MyIconFile "..\dist\t3tools.ico"
#endif

[Setup]
AppId={{7D5B3E61-4E6D-49F2-B4B6-7A06A8E4101C}}
AppName=T3Tools
AppVersion={#MyAppVersion}
AppVerName=T3Tools v{#MyAppVersion}
AppPublisher=LionKo
AppPublisherURL=https://github.com/LionKo/t3tools
AppSupportURL=https://github.com/LionKo/t3tools/issues
AppUpdatesURL=https://github.com/LionKo/t3tools/releases
DefaultDirName={localappdata}\T3Tools
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#MyOutputDir}
OutputBaseFilename=T3Tools-Setup-v{#MyAppVersion}-win-x64
SetupIconFile={#MyIconFile}
UninstallDisplayIcon={app}\T3Tools.exe
UninstallDisplayName=T3Tools
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut (创建桌面快捷方式)"; GroupDescription: "Additional options:"
Name: "autostart"; Description: "Launch silently to system tray on Windows startup (开机静默自启)"; GroupDescription: "Additional options:"; Flags: unchecked

[Files]
Source: "{#MyStageDir}\T3Tools.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyStageDir}\release.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyStageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyStageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\T3Tools"; Filename: "{app}\T3Tools.exe"; WorkingDir: "{app}"; IconFilename: "{app}\T3Tools.exe"; Comment: "T3Tools - Windows T3 Code 原生增强插件"
Name: "{autodesktop}\T3Tools"; Filename: "{app}\T3Tools.exe"; WorkingDir: "{app}"; IconFilename: "{app}\T3Tools.exe"; Comment: "T3Tools - Windows T3 Code 原生增强插件"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "T3Tools"; ValueData: """{app}\T3Tools.exe"" --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\t3tools.mjs"" patch-debug"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; StatusMsg: "Configuring T3 Code auto-attach..."
Filename: "{app}\T3Tools.exe"; WorkingDir: "{app}"; Description: "Launch T3Tools now (立即启动 T3Tools)"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\T3Tools.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "QuitT3ToolsBeforeUninstall"
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\t3tools.mjs"" uninstall"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; RunOnceId: "RestoreT3Shortcuts"

[Code]
procedure StopRunningT3Tools();
var
  ResultCode: Integer;
  InstalledExe: String;
  UserProfileDir: String;
  LegacyExe: String;
begin
  InstalledExe := ExpandConstant('{app}\T3Tools.exe');
  if FileExists(InstalledExe) then
  begin
    Exec(InstalledExe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(800);
  end;
  UserProfileDir := GetEnv('USERPROFILE');
  if UserProfileDir <> '' then
  begin
    LegacyExe := AddBackslash(UserProfileDir) + '.t3tools\T3Tools.exe';
    if FileExists(LegacyExe) then
    begin
      Exec(LegacyExe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Sleep(500);
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningT3Tools();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningT3Tools();
  end;
end;
