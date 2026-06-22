param(
  [string]$Message = "snapshot"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VersionsDir = Join-Path $ProjectRoot "versions"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$SafeMessage = $Message -replace '[\\/:*?"<>|]', '-' -replace '\s+', '-'
$Name = "$Stamp-$SafeMessage"
$SnapshotDir = Join-Path $VersionsDir $Name

New-Item -ItemType Directory -Force -Path $VersionsDir | Out-Null
New-Item -ItemType Directory -Force -Path $SnapshotDir | Out-Null

Get-ChildItem -Path $ProjectRoot -Force |
  Where-Object { $_.Name -ne "versions" } |
  Copy-Item -Destination $SnapshotDir -Recurse -Force

$LogPath = Join-Path $VersionsDir "history.txt"
"$Stamp`t$Message`t$SnapshotDir" | Add-Content -Path $LogPath -Encoding UTF8

Write-Host "Saved version:"
Write-Host $SnapshotDir
