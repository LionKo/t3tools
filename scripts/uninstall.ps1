$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== T3Tools (Windows) 卸载还原 ===" -ForegroundColor Yellow
node "$root\bin\t3tools.mjs" uninstall
if ($LASTEXITCODE -ne 0) {
  throw "快捷方式还原失败（退出码 $LASTEXITCODE）"
}
Write-Host "已还原 T3 Code 快捷方式。如需清理插件缓存，可手动删除 $env:USERPROFILE\.t3tools" -ForegroundColor Green
