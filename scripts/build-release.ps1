param(
  [string]$Version = "",
  [string]$NodeVersion = "22.16.0",
  [string]$NodeExePath = "",
  [switch]$UseLocalNode,
  [switch]$SkipInstaller,
  [string]$RepoSlug = "LionKo/t3tools",
  [string]$NotesFile = "",
  [string]$OutDir = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Version)) {
  $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $Version = [string]$pkg.version
}
$Version = $Version.Trim().TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "版本号格式无效: $Version"
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $root 'dist\release'
}
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
if (Test-Path -LiteralPath $OutDir) {
  Remove-Item -LiteralPath $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$workDir = Join-Path $OutDir '_work'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Sha256Lower([string]$FilePath) {
  return (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-PortableNodeExe {
  if (-not [string]::IsNullOrWhiteSpace($NodeExePath)) {
    if (-not (Test-Path -LiteralPath $NodeExePath)) {
      throw "指定的 NodeExePath 不存在: $NodeExePath"
    }
    return (Resolve-Path -LiteralPath $NodeExePath).Path
  }

  if ($UseLocalNode) {
    $localNode = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $localNode) { throw "未找到本机 node.exe" }
    Write-Host "使用本机 Node.js: $localNode ($(& $localNode -v))" -ForegroundColor Yellow
    return $localNode
  }

  $cacheDir = Join-Path $root 'dist\.node-cache'
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  $zipName = "node-v$NodeVersion-win-x64.zip"
  $cachedZip = Join-Path $cacheDir $zipName
  $cachedNode = Join-Path $cacheDir "node-v$NodeVersion-win-x64\node.exe"

  if (-not (Test-Path -LiteralPath $cachedNode)) {
    $baseUrl = "https://nodejs.org/dist/v$NodeVersion"
    $sumsUrl = "$baseUrl/SHASUMS256.txt"
    $zipUrl = "$baseUrl/$zipName"

    Write-Host "正在下载官方便携版 Node.js v$NodeVersion (win-x64)..." -ForegroundColor Cyan
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $sumsText = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
    $expectedLine = ($sumsText -split "`r?`n") | Where-Object { $_ -match "\s+$([Regex]::Escape($zipName))$" } | Select-Object -First 1
    if (-not $expectedLine) {
      throw "在 SHASUMS256.txt 中未找到 $zipName"
    }
    $expectedSha = ($expectedLine.Trim() -split '\s+')[0].ToLowerInvariant()

    if (-not (Test-Path -LiteralPath $cachedZip) -or (Get-Sha256Lower $cachedZip) -ne $expectedSha) {
      Invoke-WebRequest -Uri $zipUrl -OutFile $cachedZip -UseBasicParsing
      $actualSha = Get-Sha256Lower $cachedZip
      if ($actualSha -ne $expectedSha) {
        Remove-Item -LiteralPath $cachedZip -Force -ErrorAction SilentlyContinue
        throw "Node.js 压缩包 SHA-256 校验失败: expected $expectedSha, got $actualSha"
      }
    }

    $extractTarget = Join-Path $cacheDir "extract-$NodeVersion"
    if (Test-Path -LiteralPath $extractTarget) { Remove-Item -LiteralPath $extractTarget -Recurse -Force }
    Expand-Archive -LiteralPath $cachedZip -DestinationPath $extractTarget -Force
    $extractedNode = Join-Path $extractTarget "node-v$NodeVersion-win-x64\node.exe"
    if (-not (Test-Path -LiteralPath $extractedNode)) {
      throw "解压后的 Node.js 包中未找到 node.exe"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cachedNode) | Out-Null
    Copy-Item -LiteralPath $extractedNode -Destination $cachedNode -Force
    Remove-Item -LiteralPath $extractTarget -Recurse -Force -ErrorAction SilentlyContinue
  }

  return $cachedNode
}

function Copy-AppTree([string]$DestAppDir) {
  New-Item -ItemType Directory -Force -Path $DestAppDir | Out-Null
  foreach ($item in @('package.json', 'README.md', 'bin', 'config')) {
    $src = Join-Path $root $item
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $DestAppDir $item) -Recurse -Force
    }
  }
  $destSrc = Join-Path $DestAppDir 'src'
  New-Item -ItemType Directory -Force -Path $destSrc | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $root 'src') | Where-Object { $_.Name -ne 'win-tray' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destSrc $_.Name) -Recurse -Force
  }
}

function New-ReleaseMetadataJson([string]$InstallMode, [string]$BundledNodeVer) {
  $obj = [ordered]@{
    version = $Version
    channel = 'stable'
    installMode = $InstallMode
    minNodeVersion = '22.13.0'
    bundledNodeVersion = $BundledNodeVer
    builtAt = [DateTime]::UtcNow.ToString('o')
  }
  return ($obj | ConvertTo-Json -Depth 4)
}

function New-ZipFromDirectory([string]$SourceDir, [string]$ZipPath) {
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $SourceDir,
    $ZipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
}

Write-Host "=== 构建 T3Tools Release v$Version ===" -ForegroundColor Cyan

# 1. Compile T3Tools.exe with embedded version
$trayOutDir = Join-Path $workDir 'tray'
$builtExe = Join-Path $trayOutDir 'T3Tools.exe'
& (Join-Path $PSScriptRoot 'build-tray.ps1') -OutExe $builtExe -Version $Version
if ($LASTEXITCODE -ne 0) { throw "编译 T3Tools.exe 失败" }
$builtIco = Join-Path $trayOutDir 't3tools.ico'

# Also update dist\T3Tools.exe so local dist stays current
Copy-Item -LiteralPath $builtExe -Destination (Join-Path $root 'dist\T3Tools.exe') -Force
if (Test-Path -LiteralPath $builtIco) {
  Copy-Item -LiteralPath $builtIco -Destination (Join-Path $root 'dist\t3tools.ico') -Force
}

# 2. Resolve bundled portable node.exe
$bundledNodeSrc = Resolve-PortableNodeExe
$bundledNodeVer = (& $bundledNodeSrc -v).Trim().TrimStart('v')
Write-Host "内置便携 Node.js 版本: v$bundledNodeVer" -ForegroundColor Green

# 3. Build lightweight auto-update package (T3Tools-v<ver>-app.zip, ~200KB)
$appStageDir = Join-Path $workDir 'app_stage'
New-Item -ItemType Directory -Force -Path $appStageDir | Out-Null
Copy-Item -LiteralPath $builtExe -Destination (Join-Path $appStageDir 'T3Tools.exe') -Force
Copy-AppTree (Join-Path $appStageDir 'app')
[System.IO.File]::WriteAllText(
  (Join-Path $appStageDir 'release.json'),
  (New-ReleaseMetadataJson 'installed' ''),
  $utf8NoBom
)

$appZipName = "T3Tools-v$Version-app.zip"
$appZipPath = Join-Path $OutDir $appZipName
New-ZipFromDirectory $appStageDir $appZipPath

# 4. Build full portable package (with bundled runtime\node.exe)
$portableStageDir = Join-Path $workDir 'portable_stage'
Copy-Item -LiteralPath $appStageDir -Destination $portableStageDir -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $portableStageDir 'runtime') | Out-Null
Copy-Item -LiteralPath $bundledNodeSrc -Destination (Join-Path $portableStageDir 'runtime\node.exe') -Force
[System.IO.File]::WriteAllText(
  (Join-Path $portableStageDir 'release.json'),
  (New-ReleaseMetadataJson 'portable' $bundledNodeVer),
  $utf8NoBom
)

$fullZipName = "T3Tools-v$Version-win-x64-portable.zip"
$fullZipPath = Join-Path $OutDir $fullZipName
New-ZipFromDirectory $portableStageDir $fullZipPath

# 5. Build Inno Setup double-click installer (T3Tools-Setup-v<ver>-win-x64.exe)
$setupExeName = "T3Tools-Setup-v$Version-win-x64.exe"
$setupExePath = Join-Path $OutDir $setupExeName
$builtSetup = $false

if (-not $SkipInstaller) {
  $isccCandidates = @(
    (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $iscc = $isccCandidates | Select-Object -First 1

  if ($iscc) {
    $innoStageDir = Join-Path $workDir 'inno_stage'
    Copy-Item -LiteralPath $portableStageDir -Destination $innoStageDir -Recurse -Force
    [System.IO.File]::WriteAllText(
      (Join-Path $innoStageDir 'release.json'),
      (New-ReleaseMetadataJson 'installed' $bundledNodeVer),
      $utf8NoBom
    )

    Write-Host "正在使用 Inno Setup 构建一键安装包: $setupExeName ..." -ForegroundColor Cyan
    $issFile = Join-Path $root 'installer\T3Tools.iss'
    & $iscc `
      "/DMyAppVersion=$Version" `
      "/DMyStageDir=$innoStageDir" `
      "/DMyOutputDir=$OutDir" `
      "/DMyIconFile=$builtIco" `
      $issFile
    if ($LASTEXITCODE -ne 0) {
      throw "Inno Setup 构建失败（退出码 $LASTEXITCODE）"
    }
    $builtSetup = Test-Path -LiteralPath $setupExePath
  } else {
    Write-Warning "未找到 Inno Setup (ISCC.exe)，已跳过 Setup.exe 构建；在 GitHub Actions windows-latest 或安装 Inno Setup 6 后将自动生成。"
  }
}

# 6. Read optional release notes
$notesText = "T3Tools v$Version"
if (-not [string]::IsNullOrWhiteSpace($NotesFile) -and (Test-Path -LiteralPath $NotesFile)) {
  $notesText = (Get-Content -LiteralPath $NotesFile -Raw -Encoding UTF8).Trim()
}

# 7. Generate latest.json and SHA256SUMS.txt
$dlBase = "https://github.com/$RepoSlug/releases/download/v$Version"
$appSha = Get-Sha256Lower $appZipPath
$appSize = (Get-Item -LiteralPath $appZipPath).Length
$fullSha = Get-Sha256Lower $fullZipPath
$fullSize = (Get-Item -LiteralPath $fullZipPath).Length

$manifest = [ordered]@{
  version = $Version
  publishedAt = [DateTime]::UtcNow.ToString('o')
  minNodeVersion = '22.13.0'
  releaseUrl = "https://github.com/$RepoSlug/releases/tag/v$Version"
  notes = $notesText
  appPackage = [ordered]@{
    fileName = $appZipName
    url = "$dlBase/$appZipName"
    sha256 = $appSha
    size = $appSize
  }
  fullPackage = [ordered]@{
    fileName = $fullZipName
    url = "$dlBase/$fullZipName"
    sha256 = $fullSha
    size = $fullSize
  }
}
if ($builtSetup) {
  $setupSha = Get-Sha256Lower $setupExePath
  $setupSize = (Get-Item -LiteralPath $setupExePath).Length
  $manifest['installer'] = [ordered]@{
    fileName = $setupExeName
    url = "$dlBase/$setupExeName"
    sha256 = $setupSha
    size = $setupSize
  }
}

$latestJsonPath = Join-Path $OutDir 'latest.json'
[System.IO.File]::WriteAllText($latestJsonPath, ($manifest | ConvertTo-Json -Depth 5) + "`n", $utf8NoBom)

$sumLines = @(
  "$appSha  $appZipName",
  "$fullSha  $fullZipName"
)
if ($builtSetup) {
  $sumLines += "$setupSha  $setupExeName"
}
[System.IO.File]::WriteAllText((Join-Path $OutDir 'SHA256SUMS.txt'), ($sumLines -join "`n") + "`n", $utf8NoBom)

# Cleanup temp staging directory
Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`nRelease v$Version 产物已生成于: $OutDir" -ForegroundColor Green
Get-ChildItem -LiteralPath $OutDir | Select-Object Name, @{Name='SizeKB';Expression={[Math]::Round($_.Length / 1KB, 1)}} | Format-Table -AutoSize
