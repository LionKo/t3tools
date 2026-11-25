param(
  [string]$OutExe = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$srcFile = Join-Path $root 'src\win-tray\T3ToolsTray.cs'
$distDir = Join-Path $root 'dist'
if ([string]::IsNullOrWhiteSpace($OutExe)) {
  $OutExe = Join-Path $distDir 'T3Tools.exe'
}

$OutExe = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutExe)
$outDir = Split-Path -Parent $OutExe
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Locate built-in .NET Framework 4.x C# compiler (present on all Windows 10/11 machines)
$csc = Get-ChildItem "$env:SystemRoot\Microsoft.NET\Framework64\v4.*\csc.exe","$env:SystemRoot\Microsoft.NET\Framework\v4.*\csc.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $csc) {
  throw "未找到 Windows 内置 .NET Framework 4.x 编译器 (csc.exe)"
}

# Generate crisp multi-size ICO into dist\t3tools.ico using System.Drawing
$icoPath = Join-Path $outDir 't3tools.ico'
Add-Type -AssemblyName System.Drawing

function New-T3IconPngBytes([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [Math]::Max(1.0, $size * 0.06)
    $rad = [Math]::Max(3.0, $size * 0.22)
    $d = $rad * 2.0
    $x = [float]$pad; $y = [float]$pad
    $w = [float]($size - $pad * 2.0 - 1.0); $h = $w
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(27, 30, 37),
      [System.Drawing.Color]::FromArgb(11, 12, 15),
      45.0
    )
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(99, 102, 241), [float][Math]::Max(1.0, $size * 0.06))
    $g.FillPath($bg, $path)
    $g.DrawPath($borderPen, $path)

    $font = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.43), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(243, 244, 246))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString('T3', $font, $brush, (New-Object System.Drawing.RectangleF(0, [float]($size * 0.02), $size, [float]($size * 0.94))), $sf)

    $dotSize = [float][Math]::Max(4.0, $size * 0.24)
    $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(99, 102, 241))
    $g.FillEllipse($dotBrush, [float]($size - $dotSize - $pad * 1.3), [float]($size - $dotSize - $pad * 1.3), $dotSize, $dotSize)

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
  } finally {
    foreach ($resource in @($ms, $dotBrush, $sf, $brush, $font, $borderPen, $bg, $path)) {
      if ($null -ne $resource) { $resource.Dispose() }
    }
    $g.Dispose()
    $bmp.Dispose()
  }
}

$sizes = @(16, 32, 48, 256)
$pngList = @()
foreach ($sz in $sizes) {
  $pngList += ,@($sz, (New-T3IconPngBytes $sz))
}

$icoStream = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($icoStream)
$bw.Write([UInt16]0) # reserved
$bw.Write([UInt16]1) # type = ICO
$bw.Write([UInt16]$pngList.Count)

$offset = 6 + 16 * $pngList.Count
foreach ($entry in $pngList) {
  $sz = [int]$entry[0]
  $bytes = [byte[]]$entry[1]
  $bSz = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
  $bw.Write($bSz) # width
  $bw.Write($bSz) # height
  $bw.Write([byte]0) # color palette
  $bw.Write([byte]0) # reserved
  $bw.Write([UInt16]1) # planes
  $bw.Write([UInt16]32) # bpp
  $bw.Write([UInt32]$bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $bytes.Length
}
foreach ($entry in $pngList) {
  $bw.Write([byte[]]$entry[1])
}
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $icoStream.ToArray())
$bw.Dispose()
$icoStream.Dispose()

# Write DPI-aware application manifest
$manifestPath = Join-Path $outDir 'T3Tools.exe.manifest'
$manifestXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="T3Tools.Tray" type="win32"/>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/PM</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
'@
[System.IO.File]::WriteAllText($manifestPath, $manifestXml, [System.Text.Encoding]::UTF8)

Write-Host "正在编译原生 Windows 托盘程序: $OutExe ..." -ForegroundColor Cyan
$cscArgs = @(
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/utf8output',
  "/out:$OutExe",
  "/win32icon:$icoPath",
  "/win32manifest:$manifestPath",
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  '/r:System.Web.Extensions.dll',
  $srcFile
)

$output = & $csc @cscArgs 2>&1
if ($LASTEXITCODE -ne 0) {
  $output | ForEach-Object { Write-Error $_ }
  throw "编译 T3Tools.exe 失败（退出码 $LASTEXITCODE）"
}

Write-Host "编译成功: $OutExe ($([Math]::Round((Get-Item $OutExe).Length / 1KB, 1)) KB)" -ForegroundColor Green
