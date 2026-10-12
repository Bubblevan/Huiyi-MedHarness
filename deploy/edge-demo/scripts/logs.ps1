param([string[]]$Service = @())

$ErrorActionPreference = 'Stop'
$DeploymentRoot = Split-Path -Parent $PSScriptRoot
$Arguments = @('compose', '--project-directory', $DeploymentRoot, '--env-file', (Join-Path $DeploymentRoot '.env'), '-f', (Join-Path $DeploymentRoot 'compose.yaml'), 'logs', '--tail', '150', '--follow')
if ($Service.Count) { $Arguments += $Service }
& docker @Arguments
if ($LASTEXITCODE -ne 0) { throw 'Unable to read edge-demo service logs.' }
