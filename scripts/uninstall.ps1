$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== T3Tools (Windows) 卸载还原 ===" -ForegroundColor Yellow

$installedExe = Join-Path $env:USERPROFILE '.t3tools\T3Tools.exe'
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
  if (-not (Get-InstalledTrayProcess)) { break }
  Start-Sleep -Milliseconds 200
}
Get-InstalledTrayProcess | Stop-Process -Force -ErrorAction SilentlyContinue

node "$root\bin\t3tools.mjs" stop 2>$null
node "$root\bin\t3tools.mjs" uninstall
if ($LASTEXITCODE -ne 0) {
  throw "快捷方式还原失败（退出码 $LASTEXITCODE）"
}

if (Test-Path -LiteralPath $installedExe) {
  Remove-Item -LiteralPath $installedExe -Force -ErrorAction SilentlyContinue
}

Write-Host "已还原 T3 Code 快捷方式，并移除 T3Tools 托盘快捷方式与开机自启。" -ForegroundColor Green
Write-Host "如需清理插件缓存，可手动删除 $env:USERPROFILE\.t3tools"
