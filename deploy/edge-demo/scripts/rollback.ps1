param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{7,40}$')][string]$Revision
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$Status = & git -C $RepoRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git worktree.' }
if ($Status) { throw 'Rollback requires a clean worktree. Preserve or commit current changes first.' }
& git -C $RepoRoot cat-file -e "$Revision^{commit}"
if ($LASTEXITCODE -ne 0) { throw "Unknown rollback commit: $Revision" }
& git -C $RepoRoot switch --detach $Revision
if ($LASTEXITCODE -ne 0) { throw 'Could not switch to the requested rollback revision.' }
& (Join-Path $PSScriptRoot 'up.ps1')
