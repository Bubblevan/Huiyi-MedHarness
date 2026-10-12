param([int]$HttpsPort = 8443)

$ErrorActionPreference = 'Stop'
$Curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $Curl) { throw 'curl.exe is required for the local self-signed TLS health check.' }
& curl.exe --silent --show-error --insecure --fail "https://localhost:$HttpsPort/healthz"
if ($LASTEXITCODE -ne 0) { throw 'Edge HTTPS health check failed.' }
& curl.exe --silent --show-error --insecure --fail "https://localhost:$HttpsPort/api/health"
if ($LASTEXITCODE -ne 0) { throw 'Gateway health through the edge proxy failed.' }
