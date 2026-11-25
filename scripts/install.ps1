$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== T3Tools (Windows · 方案 A 联动启停) 安装配置 ===" -ForegroundColor Cyan

$nodeVer = node -v
if ($LASTEXITCODE -ne 0) { throw "未找到 Node.js，请先安装 Node.js >= 22.13" }
Write-Host "检测到 Node.js: $nodeVer"
$parts = $nodeVer.TrimStart('v').Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) {
  throw "需要 Node.js >= 22.13（当前 $nodeVer）"
}

Write-Host "1. 生成无黑框静默启动器并绑定桌面/开始菜单 T3 Code 快捷方式（保留原图标，不修改安装文件）..."
node "$root\bin\t3tools.mjs" install
if ($LASTEXITCODE -ne 0) {
  throw "快捷方式配置失败（退出码 $LASTEXITCODE）"
}

Write-Host "2. 运行环境自检..."
node "$root\bin\t3tools.mjs" doctor
if ($LASTEXITCODE -ne 0) {
  throw "环境自检失败（退出码 $LASTEXITCODE）"
}

Write-Host "`n安装完成！" -ForegroundColor Green
Write-Host "以后直接双击桌面或开始菜单的 T3 Code 图标即可自动启动并挂载插件，无需再开终端。"
Write-Host "关闭 T3 Code 后，守护进程也会自动退出（平时零后台常驻）。"
