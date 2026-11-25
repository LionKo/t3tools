param(
  [switch]$WrapperMode,
  [switch]$AutoStart,
  [switch]$StartMinimized,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== T3Tools (Windows · Magpie 风格托盘自动吸附) 安装配置 ===" -ForegroundColor Cyan

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw "未找到 Node.js，请先安装 Node.js >= 22.13" }
$nodeVer = & $nodeExe -v
if ($LASTEXITCODE -ne 0) { throw "无法运行 Node.js" }
Write-Host "检测到 Node.js: $nodeVer ($nodeExe)"
$parts = $nodeVer.TrimStart('v').Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) {
  throw "需要 Node.js >= 22.13（当前 $nodeVer）"
}

if ($WrapperMode) {
  Write-Host "1. 兼容模式：配置方案 A（T3 Code 图标联动启停）..."
  & $nodeExe "$root\bin\t3tools.mjs" install
  if ($LASTEXITCODE -ne 0) { throw "快捷方式配置失败（退出码 $LASTEXITCODE）" }
  & $nodeExe "$root\bin\t3tools.mjs" doctor
  exit $LASTEXITCODE
}

$pluginDir = Join-Path $env:USERPROFILE '.t3tools'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null

# Stop any previously running tray instance cleanly before replacing exe
$installedExe = Join-Path $pluginDir 'T3Tools.exe'
function Get-InstalledTrayProcess {
  Get-Process -Name 'T3Tools' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe }
}
if ((Test-Path -LiteralPath $installedExe) -and (Get-InstalledTrayProcess)) {
  try {
    Start-Process -FilePath $installedExe -ArgumentList '--quit' -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
  } catch {}
}
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while ([DateTime]::UtcNow -lt $deadline) {
  $runningTray = Get-InstalledTrayProcess
  if (-not $runningTray) { break }
  Start-Sleep -Milliseconds 200
}
Get-InstalledTrayProcess | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 200

Write-Host "1. 编译原生 Windows 托盘程序 T3Tools.exe（零外部依赖）..."
$distExe = Join-Path $root 'dist\T3Tools.exe'
& (Join-Path $PSScriptRoot 'build-tray.ps1') -OutExe $distExe
if ($LASTEXITCODE -ne 0) { throw "编译 T3Tools.exe 失败" }

Copy-Item -LiteralPath $distExe -Destination $installedExe -Force

# Save tray-config.json so T3Tools.exe knows repoRoot and nodeExe regardless of location
$trayConfig = @{
  repoRoot = $root
  cliPath = (Join-Path $root 'bin\t3tools.mjs')
  nodeExe = $nodeExe
  installedExe = $installedExe
  updatedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText((Join-Path $pluginDir 'tray-config.json'), $trayConfig, [System.Text.Encoding]::UTF8)

Write-Host "2. 为 T3 Code 快捷方式注入自动吸附调试参数 (--remote-debugging-port=0，保留原图标不改包)..."
& $nodeExe "$root\bin\t3tools.mjs" patch-debug
if ($LASTEXITCODE -ne 0) {
  Write-Warning "未自动配置 T3 Code 快捷方式，稍后也可在托盘菜单手动配置。"
}

Write-Host "3. 创建桌面与开始菜单 T3Tools 快捷方式..."
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
foreach ($dir in @($desktop, $programs)) {
  if ($dir -and (Test-Path -LiteralPath $dir)) {
    $lnkPath = Join-Path $dir 'T3Tools.lnk'
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = $installedExe
    $sc.Arguments = if ($StartMinimized) { '--tray' } else { '' }
    $sc.WorkingDirectory = $pluginDir
    $sc.IconLocation = "$installedExe,0"
    $sc.Description = 'T3Tools - 启动后缩放到托盘并自动吸附 T3 Code'
    $sc.Save()
    Write-Host "  - 已创建: $lnkPath"
  }
}

if ($AutoStart) {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
  Set-ItemProperty -Path $runKey -Name 'T3Tools' -Value "`"$installedExe`" --tray"
  Write-Host "  - 已开启开机自动启动（托盘静默模式）" -ForegroundColor Green
}

Write-Host "4. 运行环境自检..."
& $nodeExe "$root\bin\t3tools.mjs" doctor
if ($LASTEXITCODE -ne 0) {
  throw "环境自检失败（退出码 $LASTEXITCODE）"
}

Write-Host "`n安装完成！" -ForegroundColor Green
Write-Host "  - 托盘程序位置: $installedExe（及项目内 $distExe）"
Write-Host "  - 双击桌面/开始菜单的「T3Tools」即可启动：支持最小化/关闭缩放到右下角托盘，并自动吸附到 T3 Code。"

if (-not $NoLaunch) {
  Write-Host "正在启动 T3Tools 托盘程序..." -ForegroundColor Cyan
  $launchArgs = if ($StartMinimized) { @('--tray') } else { @() }
  if ($launchArgs.Count -gt 0) {
    Start-Process -FilePath $installedExe -ArgumentList $launchArgs
  } else {
    Start-Process -FilePath $installedExe
  }
}
