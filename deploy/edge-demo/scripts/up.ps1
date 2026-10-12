param(
  [switch]$SkipGatewayHealthCheck
)

$ErrorActionPreference = 'Stop'
$DeploymentRoot = Split-Path -Parent $PSScriptRoot
$RepositoryRoot = Resolve-Path (Join-Path $DeploymentRoot '..\..')
$ComposeFile = Join-Path $DeploymentRoot 'compose.yaml'
$EnvFile = Join-Path $DeploymentRoot '.env'

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Missing $EnvFile. Copy .env.example to .env and review the local-only defaults first."
}
if (-not $SkipGatewayHealthCheck) {
  try {
    $Gateway = Invoke-RestMethod -Uri 'http://127.0.0.1:8320/api/health' -TimeoutSec 3
    if ($Gateway.status -ne 'ok') { throw 'Gateway health was not ok.' }
  } catch {
    throw 'Start the synthetic clinical-evaluation Gateway on port 8320 first, then rerun this script.'
  }
}

$DockerVersion = & docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $DockerVersion) {
  throw 'Docker Engine is not reachable. Start Docker Desktop; this script does not install or download Docker.'
}

$Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $Pnpm) { throw 'pnpm is required to build the clinical-evaluation frontend before creating the static edge image.' }
Push-Location $RepositoryRoot.Path
try {
  & $Pnpm.Source --filter @huiyi/demo-web clinical-evaluation:build
  if ($LASTEXITCODE -ne 0) { throw 'Clinical-evaluation frontend build failed; edge image was not built.' }
} finally {
  Pop-Location
}

& docker compose --project-directory $DeploymentRoot --env-file $EnvFile -f $ComposeFile config | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Compose configuration validation failed.' }
& docker compose --project-directory $DeploymentRoot --env-file $EnvFile -f $ComposeFile up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Compose startup failed.' }

$HttpsPort = 8443
if (Test-Path -LiteralPath $EnvFile) {
  $PortLine = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^EDGE_HTTPS_PORT=' } | Select-Object -First 1
  if ($PortLine) { $HttpsPort = [int]($PortLine -split '=', 2)[1] }
}
Write-Host "Edge portal started. Open https://localhost:$HttpsPort/ (Caddy local CA is not pre-trusted by this script)."
