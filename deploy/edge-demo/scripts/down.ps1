$ErrorActionPreference = 'Stop'
$DeploymentRoot = Split-Path -Parent $PSScriptRoot
& docker compose --project-directory $DeploymentRoot --env-file (Join-Path $DeploymentRoot '.env') -f (Join-Path $DeploymentRoot 'compose.yaml') down
if ($LASTEXITCODE -ne 0) { throw 'Compose shutdown failed.' }
