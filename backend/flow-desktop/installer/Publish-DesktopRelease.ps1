# Publish the verified MSI first, then atomically switch release metadata. Same-version binaries are immutable.
param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$Destination,
  [string]$ReleaseNotes = '',
  [string[]]$CompatibleServerVersions
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$ReleaseVersion = [IO.File]::ReadAllText((Join-Path $Root 'VERSION')).Trim()
if ($ReleaseVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid VERSION.' }
if (-not $CompatibleServerVersions) { $CompatibleServerVersions = @($ReleaseVersion) }
foreach ($Value in $CompatibleServerVersions) {
  if ($Value -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid compatible server version.' }
}
if ($ReleaseNotes.Length -gt 12000) { throw 'Release notes must be at most 12000 characters.' }
$Source = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([IO.Path]::GetExtension($Source) -ne '.msi') { throw 'Only Windows MSI packages are supported.' }
# Inspect the MSI itself; an arbitrary renamed file must not become an executable release.
$WindowsInstaller = New-Object -ComObject WindowsInstaller.Installer
$Database = $WindowsInstaller.OpenDatabase($Source, 0)
$Query = $Database.OpenView('SELECT `Property`, `Value` FROM `Property`')
$Properties = @{}
try {
  $Query.Execute()
  while ($Record = $Query.Fetch()) {
    $Properties[$Record.StringData(1)] = $Record.StringData(2)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Record)
  }
} finally {
  $Query.Close()
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Query)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Database)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($WindowsInstaller)
}
if ($Properties.ProductName -ne 'FlowLink' -or $Properties.ProductVersion -ne $ReleaseVersion -or
    $Properties.UpgradeCode -ne '{B06C875D-2E09-4B64-9E3D-2F52E871D069}') { throw 'MSI product/version/upgrade identity does not match this release.' }
$Hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
$Size = (Get-Item -LiteralPath $Source).Length
if ($Size -lt 1 -or $Size -gt 1GB) { throw 'MSI size must be between 1 byte and 1 GiB.' }
$Name = "FlowLink-$ReleaseVersion-windows-x64.msi"
$null = New-Item -ItemType Directory -Path $Destination -Force
$Directory = (Resolve-Path -LiteralPath $Destination).Path
$Artifact = Join-Path $Directory $Name
if (Test-Path -LiteralPath $Artifact) {
  if ((Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'This version already has a different MSI. Increment VERSION instead of overwriting.' }
} else {
  $Staged = Join-Path $Directory ('.artifact-' + [guid]::NewGuid().ToString('N') + '.tmp')
  Copy-Item -LiteralPath $Source -Destination $Staged
  if ((Get-FileHash -LiteralPath $Staged -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'Staged MSI checksum mismatch.' }
  [IO.File]::Move($Staged, $Artifact)
}
$Manifest = [ordered]@{
  schemaVersion = 1; version = $ReleaseVersion; platform = 'windows'; arch = 'x64'
  downloadPath = "/downloads/$Name"; size = $Size; sha256 = $Hash
  releaseNotes = $ReleaseNotes; compatibleServerVersions = @($CompatibleServerVersions)
}
$Pending = Join-Path $Directory ('.manifest-' + [guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($Pending, ($Manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$Published = Join-Path $Directory 'release-manifest.json'
if (Test-Path -LiteralPath $Published) { [IO.File]::Replace($Pending, $Published, [NullString]::Value) }
else { [IO.File]::Move($Pending, $Published) }
Write-Output "Published FlowLink $ReleaseVersion ($Size bytes) to $Directory"
