# Generate the native brand assets and extend the installed JDK's WiX template.
param(
  [Parameter(Mandatory)][string]$OutputDir,
  [Parameter(Mandatory)][string]$JdkPath,
  [string]$WixPath,
  [switch]$Installer
)
$ErrorActionPreference = 'Stop'
$ResourceDir = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $ResourceDir -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$Primary = [Drawing.ColorTranslator]::FromHtml('#245cdd')

function Draw-Mark([Drawing.Graphics]$Canvas, [single]$X, [single]$Y, [single]$Size) {
  $saved = $Canvas.Save()
  $Canvas.TranslateTransform($X, $Y); $Canvas.ScaleTransform($Size / 64, $Size / 64)
  $Canvas.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $shape = [Drawing.Drawing2D.GraphicsPath]::new()
  $shape.AddArc(2, 2, 18, 18, 180, 90); $shape.AddArc(44, 2, 18, 18, 270, 90)
  $shape.AddArc(44, 44, 18, 18, 0, 90); $shape.AddArc(2, 44, 18, 18, 90, 90); $shape.CloseFigure()
  $brush = [Drawing.SolidBrush]::new($Primary)
  $pen = [Drawing.Pen]::new([Drawing.Color]::White, 7)
  $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
  $Canvas.FillPath($brush, $shape)
  $Canvas.DrawLine($pen, 20, 43, 20, 24); $Canvas.DrawLine($pen, 20, 24, 44, 24); $Canvas.DrawLine($pen, 20, 36, 39, 36)
  $Canvas.FillEllipse([Drawing.Brushes]::White, 13, 36, 14, 14); $Canvas.FillEllipse([Drawing.Brushes]::White, 37, 17, 14, 14)
  $shape.Dispose(); $brush.Dispose(); $pen.Dispose(); $Canvas.Restore($saved)
}
$IconImages = @()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
  $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap); Draw-Mark $graphics 0 0 $size; $graphics.Dispose()
  $memory = [IO.MemoryStream]::new(); $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
  $IconImages += @{ Size = $size; Bytes = $memory.ToArray() }
  if ($size -eq 256) { $bitmap.Save((Join-Path $ResourceDir 'FlowLink.png'), [Drawing.Imaging.ImageFormat]::Png) }
  $memory.Dispose(); $bitmap.Dispose()
}
$stream = [IO.File]::Create((Join-Path $ResourceDir 'FlowLink.ico'))
$writer = [IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$IconImages.Count)
  $offset = 6 + 16 * $IconImages.Count
  foreach ($entry in $IconImages) {
    $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset); $offset += $entry.Bytes.Length
  }
  foreach ($entry in $IconImages) { $writer.Write([byte[]]$entry.Bytes) }
} finally { $writer.Dispose(); $stream.Dispose() }
if (-not $Installer) { return }

foreach ($kind in @('banner', 'dialog')) {
  $height = if ($kind -eq 'banner') { 58 } else { 312 }
  $bitmap = [Drawing.Bitmap]::new(493, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap); $graphics.Clear([Drawing.Color]::White)
  if ($kind -eq 'banner') { Draw-Mark $graphics 438 8 42 }
  else {
    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#edf3ff'))
    $graphics.FillRectangle($brush, 0, 0, 164, 312); $brush.Dispose(); Draw-Mark $graphics 34 34 78
    $font = [Drawing.Font]::new('Segoe UI', 19, [Drawing.FontStyle]::Bold)
    $graphics.DrawString('FlowLink', $font, [Drawing.Brushes]::Black, 24, 128); $font.Dispose()
    $font = [Drawing.Font]::new('맑은 고딕', 10)
    $graphics.DrawString(('내 PC와 사내 서버' + [Environment]::NewLine + '하나의 워크플로'), $font, [Drawing.Brushes]::DimGray, 24, 167)
    $graphics.DrawString(('Windows 앱' + [Environment]::NewLine + '개인 작업은 내 PC에'), $font, [Drawing.Brushes]::DimGray, 24, 253); $font.Dispose()
  }
  $graphics.Dispose(); $bitmap.Save((Join-Path $ResourceDir "$kind.bmp"), [Drawing.Imaging.ImageFormat]::Bmp); $bitmap.Dispose()
}
$ExtractDir = Join-Path $ResourceDir 'jdk-template'
New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
Push-Location $ExtractDir
try {
  & (Join-Path $JdkPath 'bin/jar.exe') xf (Join-Path $JdkPath 'jmods/jdk.jpackage.jmod') classes/jdk/jpackage/internal/resources/main.wxs
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the JDK jpackage Windows template.' }
} finally { Pop-Location }
$main = [IO.File]::ReadAllText((Join-Path $ExtractDir 'classes/jdk/jpackage/internal/resources/main.wxs'))
$fragment = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'FlowLinkSetup.wxi'))
$fragment = $fragment.Replace('__BANNER__', [Security.SecurityElement]::Escape((Join-Path $ResourceDir 'banner.bmp'))).Replace('__DIALOG__', [Security.SecurityElement]::Escape((Join-Path $ResourceDir 'dialog.bmp')))
$anchor = '<UIRef Id="JpUI"/>'
if (-not $main.Contains($anchor)) { throw 'The JDK jpackage UI template changed. Review the installer integration before packaging.' }
$main = $main.Replace($anchor, $anchor + [Environment]::NewLine + $fragment).Replace('Language="$(var.JpProductLanguage)"', 'Language="$(var.JpProductLanguage)" Codepage="949"')
[IO.File]::WriteAllText((Join-Path $ResourceDir 'main.wxs'), $main, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $ResourceDir 'overrides.wxi'), @'
<?xml version="1.0" encoding="utf-8"?>
<Include>
  <?undef JpProductLanguage?>
  <?define JpProductLanguage=1042?>
  <?undef JpAllowDowngrades?>
</Include>
'@, [Text.UTF8Encoding]::new($false))

# Reuse the WiX Korean localization, including its standard dialog and Windows error strings.
if (-not $WixPath) {
  $candle = Get-Command candle.exe -ErrorAction SilentlyContinue
  if ($candle) { $WixPath = Split-Path -Parent $candle.Source }
  else {
    foreach ($programRoot in @([Environment]::GetFolderPath('ProgramFilesX86'), $env:ProgramFiles) | Where-Object { $_ }) {
      foreach ($version in @('3.14', 'v3.14', 'v3.11', 'v3.10')) {
        $candidate = Join-Path $programRoot "WiX Toolset $version\bin"
        if (Test-Path -LiteralPath (Join-Path $candidate 'WixUIExtension.dll')) { $WixPath = $candidate; break }
      }
      if ($WixPath) { break }
    }
  }
  if (-not $WixPath) { throw 'Pass -WixPath with the WiX 3 bin directory to generate the Korean installer UI.' }
}
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath((Join-Path $WixPath 'WixUIExtension.dll')))
$reader = [IO.StreamReader]::new($assembly.GetManifestResourceStream('Microsoft.Tools.WindowsInstallerXml.Extensions.Data.ui.wixlib'))
try { $library = $reader.ReadToEnd() } finally { $reader.Dispose() }
$match = [regex]::Match($library, '(?s)<WixLocalization\b[^>]*Culture="ko-kr"[^>]*>.*?</WixLocalization>')
if (-not $match.Success) { throw 'The WiX UI extension does not include Korean translations.' }
[xml]$localization = $match.Value
$localization.DocumentElement.SetAttribute('Culture', 'en-us')
$strings = @{
  'message.install.dir.exist' = '[INSTALLDIR] 폴더가 이미 있습니다. 이 폴더에 설치할까요?'
  MainFeatureTitle = 'FlowLink Windows 앱'
  DowngradeErrorMessage = '더 최신 버전의 FlowLink가 설치되어 있습니다. 최신 설치파일을 사용하세요.'
  DisallowUpgradeErrorMessage = '기존 FlowLink를 종료하고 새 설치파일로 다시 진행하세요.'
  ShortcutPromptDlg_Title = '[ProductName] 설치'
  ShortcutPromptDlgTitle = '{\WixUI_Font_Title}바로가기'
  ShortcutPromptDlgBannerBitmap = 'WixUI_Bmp_Banner'
  ShortcutPromptDlgDescription = '만들 바로가기를 선택하세요.'
  ShortcutPromptDlgDesktopShortcutControlLabel = '바탕 화면에 바로가기 만들기'
  ShortcutPromptDlgStartMenuShortcutControlLabel = '시작 메뉴에 바로가기 만들기'
  InstallDirNotEmptyDlg_Title = '[ProductName] 설치'
  ContextMenuCommandLabel = '[ProductName](으)로 열기'
  WelcomeDlgTitle = '{\WixUI_Font_Bigger}FlowLink 설치'
  WelcomeDlgDescription = '개인 PC에서 작업하고 사내 서버에 연결하는 Windows 앱을 설치합니다. 계속하려면 다음을 누르세요.'
  ExitDialogTitle = '{\WixUI_Font_Bigger}FlowLink 설치 완료'
  ExitDialogDescription = '완료를 누르면 설치가 끝납니다.'
}
foreach ($key in $strings.Keys) {
  $element = $localization.DocumentElement.SelectSingleNode("*[@Id='$key']")
  if (-not $element) {
    $element = $localization.CreateElement('String', 'http://schemas.microsoft.com/wix/2006/localization')
    $element.SetAttribute('Id', $key); [void]$localization.DocumentElement.AppendChild($element)
  }
  $element.InnerText = $strings[$key]
}
$localization.Save((Join-Path $ResourceDir 'MsiInstallerStrings_en.wxl'))
