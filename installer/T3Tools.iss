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

[InstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\_staging"

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

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\_staging"
Type: files; Name: "{app}\T3Tools.exe"
Type: files; Name: "{app}\release.json"
Type: files; Name: "{app}\_update_tx.json"

[Code]
procedure WaitAndStopDirectoryProcesses(TargetDir: String);
var
  ResultCode: Integer;
  PsCmd: String;
  EscDir: String;
begin
  if TargetDir = '' then Exit;
  EscDir := TargetDir;
  StringChangeEx(EscDir, '''', '''''', True);
  PsCmd :=
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
    '$dir = ([IO.Path]::GetFullPath(''' + EscDir + ''')).TrimEnd(''\'') + ''\''; ' +
    '$deadline = [DateTime]::UtcNow.AddSeconds(6); ' +
    'while ([DateTime]::UtcNow -lt $deadline) { ' +
    '  $alive = @(Get-Process -Name T3Tools,node -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } catch { $false } }); ' +
    '  if ($alive.Count -eq 0) { break }; ' +
    '  Start-Sleep -Milliseconds 200 ' +
    '}; ' +
    'Get-Process -Name T3Tools,node -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure StopRunningT3Tools();
var
  ResultCode: Integer;
  InstalledDir: String;
  InstalledExe: String;
  UserProfileDir: String;
  LegacyDir: String;
  LegacyExe: String;
begin
  InstalledDir := ExpandConstant('{app}');
  InstalledExe := AddBackslash(InstalledDir) + 'T3Tools.exe';
  if FileExists(InstalledExe) then
  begin
    Exec(InstalledExe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    WaitAndStopDirectoryProcesses(InstalledDir);
  end;
  UserProfileDir := GetEnv('USERPROFILE');
  if UserProfileDir <> '' then
  begin
    LegacyDir := AddBackslash(UserProfileDir) + '.t3tools';
    LegacyExe := AddBackslash(LegacyDir) + 'T3Tools.exe';
    if FileExists(LegacyExe) then
    begin
      Exec(LegacyExe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      WaitAndStopDirectoryProcesses(LegacyDir);
    end;
  end;
end;

procedure MigrateLegacyInstall();
var
  RunVal: String;
  UserProfileDir: String;
  LegacyExe: String;
  NewExe: String;
  NewRunVal: String;
  PsCmd: String;
  ResultCode: Integer;
begin
  UserProfileDir := GetEnv('USERPROFILE');
  if UserProfileDir = '' then Exit;
  LegacyExe := AddBackslash(UserProfileDir) + '.t3tools\T3Tools.exe';
  NewExe := ExpandConstant('{app}\T3Tools.exe');

  // If HKCU\...\Run\T3Tools still points to legacy ~/.t3tools/T3Tools.exe, migrate it to the newly installed exe
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'T3Tools', RunVal) then
  begin
    if Pos(LowerCase(LegacyExe), LowerCase(RunVal)) > 0 then
    begin
      NewRunVal := '"' + NewExe + '" --tray';
      RegWriteStringValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'T3Tools', NewRunVal);
    end;
  end;

  // Migrate any existing Desktop/Start Menu shortcut pointing at legacy ~/.t3tools/T3Tools.exe
  NewRunVal := LegacyExe;
  StringChangeEx(NewRunVal, '''', '''''', True);
  RunVal := NewExe;
  StringChangeEx(RunVal, '''', '''''', True);
  PsCmd :=
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
    '$ws = New-Object -ComObject WScript.Shell; ' +
    '$legacy = [IO.Path]::GetFullPath(''' + NewRunVal + '''); ' +
    '$newExe = [IO.Path]::GetFullPath(''' + RunVal + '''); ' +
    '$newDir = Split-Path -Parent $newExe; ' +
    'foreach ($d in @([Environment]::GetFolderPath(''Desktop''), [Environment]::GetFolderPath(''Programs''))) { ' +
    '  if (-not $d) { continue }; ' +
    '  $lnk = Join-Path $d ''T3Tools.lnk''; ' +
    '  if (Test-Path -LiteralPath $lnk) { ' +
    '    $sc = $ws.CreateShortcut($lnk); ' +
    '    if ($sc.TargetPath -and ([IO.Path]::GetFullPath($sc.TargetPath) -ieq $legacy)) { ' +
    '      $sc.TargetPath = $newExe; $sc.WorkingDirectory = $newDir; $sc.IconLocation = ($newExe + '',0''); $sc.Save() ' +
    '    } ' +
    '  } ' +
    '}"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // Remove stale legacy binary so old shortcuts cannot silently launch the obsolete version (keeps all user data in .t3tools)
  if FileExists(LegacyExe) then
  begin
    DeleteFile(LegacyExe);
  end;
end;

procedure CleanupInstalledAutoStart();
var
  RunVal: String;
  InstalledExe: String;
begin
  InstalledExe := ExpandConstant('{app}\T3Tools.exe');
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'T3Tools', RunVal) then
  begin
    if Pos(LowerCase(InstalledExe), LowerCase(RunVal)) > 0 then
    begin
      RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'T3Tools');
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningT3Tools();
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    MigrateLegacyInstall();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningT3Tools();
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    CleanupInstalledAutoStart();
  end;
end;
