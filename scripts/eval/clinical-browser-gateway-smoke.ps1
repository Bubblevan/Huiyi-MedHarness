param(
  [ValidateRange(1024, 65535)][int]$GatewayPort = 8351,
  [ValidateRange(1024, 65535)][int]$WebPort = 5177,
  [ValidateRange(1024, 65535)][int]$BridgePort = 8333,
  [string]$HealthEngineUrl = 'http://127.0.0.1:8325',
  [switch]$RunModelChat
)

$ErrorActionPreference = 'Stop'
$managedEnvironmentVariables = @(
  'NODE_ENV', 'HUIYI_APP_ENV', 'HUIYI_EVAL_USERS_JSON', 'HUIYI_EVAL_ALLOWED_ORIGINS',
  'HUIYI_DEMO_BACKEND', 'HUIYI_DEMO_MODEL_BACKEND', 'HUIYI_DEMO_CODEX_MODEL',
  'HUIYI_CODEX_BRIDGE_URL', 'HUIYI_CODEX_BRIDGE_API_KEY', 'HUIYI_DEMO_GATEWAY_PORT',
  'HUIYI_DEMO_WEB_PORT', 'HUIYI_EVAL_WEB_PORT', 'HUIYI_EVAL_BROWSER_GATEWAY',
  'HUIYI_EVAL_CHROMIUM_PATH', 'HUIYI_EVAL_BROWSER_USER', 'HUIYI_EVAL_BROWSER_PASSWORD',
  'HUIYI_HEALTH_ENGINE_URL', 'HUIYI_DEMO_SYNTHETIC_AMA_MEMORY', 'HUIYI_DEMO_MAX_TOKENS',
  'HUIYI_EVAL_BROWSER_CHAT', 'HUIYI_EVAL_BROWSER_RESULT_PATH'
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironmentVariables) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$gateway = $null
$completed = $false
$cleanupProblem = $null
if ($GatewayPort -eq $WebPort) { throw 'GatewayPort and WebPort must differ.' }
if ($BridgePort -in @($GatewayPort, $WebPort)) { throw 'BridgePort must differ from GatewayPort and WebPort.' }
foreach ($port in @($GatewayPort, $WebPort)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is occupied; refusing to reuse or stop an existing listener."
  }
}

$bridgeBase = "http://127.0.0.1:$BridgePort/v1"
$bridgeApiKey = if ([string]::IsNullOrWhiteSpace($env:HUIYI_CODEX_BRIDGE_API_KEY)) { 'local-only' } else { $env:HUIYI_CODEX_BRIDGE_API_KEY }
$route = $null
$ragStatus = $null
if ($RunModelChat) {
  $engineUri = $null
  if (-not [Uri]::TryCreate($HealthEngineUrl, [UriKind]::Absolute, [ref]$engineUri) -or
      $engineUri.Scheme -ne 'http' -or $engineUri.Host -notin @('127.0.0.1', 'localhost', '[::1]') -or
      $engineUri.UserInfo -or $engineUri.Query -or $engineUri.Fragment) {
    throw 'Model browser E2E requires a loopback Health Engine URL.'
  }
  $bridgeHealth = Invoke-RestMethod "http://127.0.0.1:$BridgePort/healthz" -TimeoutSec 5
  $bridgeModels = Invoke-RestMethod "$bridgeBase/models" -Headers @{ Authorization = "Bearer $bridgeApiKey" } -TimeoutSec 5
  $route = Invoke-RestMethod "$($HealthEngineUrl.TrimEnd('/'))/_internal/evaluation/config" -TimeoutSec 5
  $ragStatus = Invoke-RestMethod "$($HealthEngineUrl.TrimEnd('/'))/v1/rag/status" -TimeoutSec 10
  $expectedEndpoint = "$bridgeBase/chat/completions"
  if ($bridgeHealth.status -ne 'ok' -or $bridgeHealth.model -ne 'gpt-6-luna' -or $bridgeHealth.route -ne 'codex-app-server' -or
      -not ($bridgeHealth.maxConcurrentTurns -is [int] -or $bridgeHealth.maxConcurrentTurns -is [long]) -or
      @($bridgeModels.data | Where-Object { $_.id -eq 'gpt-6-luna' }).Count -ne 1 -or
      $route.amaModel -ne 'gpt-6-luna' -or $route.amaEndpoint -ne $expectedEndpoint -or
      $route.ragPlannerModel -ne 'gpt-6-luna' -or $route.ragPlannerEndpoint -ne $expectedEndpoint -or
      $route.ragEnabled -ne $true -or $route.memoryRecallIsolation -ne $true -or
      $route.embeddingModel -notmatch 'Qwen3-Embedding-0\.6B' -or $ragStatus.status -ne 'ready') {
    throw 'Model browser E2E preflight failed: bridge, AMA/planner route, local retrieval assets, or memory isolation did not attest.'
  }
}

$browserRoot = Join-Path $env:LOCALAPPDATA 'ms-playwright'
$browserPath = Get-ChildItem -LiteralPath $browserRoot -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'chrome-win64/chrome.exe' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1
if (-not $browserPath) { throw 'No cached Playwright Chromium executable was found. This script never installs or downloads a browser.' }

$password = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$accounts = @(@{
  username = 'browser-smoke'
  password = $password
  subjectId = 'browser-smoke'
  displayName = 'Synthetic Browser Reviewer'
  tenantId = 'evaluation-tenant-1'
  accessGroup = 'cohort-a'
  role = 'clinician'
})

try {
$env:NODE_ENV = 'development'
$env:HUIYI_APP_ENV = 'clinical-evaluation'
$env:HUIYI_EVAL_USERS_JSON = ConvertTo-Json -InputObject $accounts -Compress
$env:HUIYI_EVAL_ALLOWED_ORIGINS = "http://127.0.0.1:$WebPort,http://localhost:$WebPort"
$env:HUIYI_DEMO_BACKEND = 'dsh'
$env:HUIYI_DEMO_MODEL_BACKEND = 'codex-app-server'
$env:HUIYI_DEMO_CODEX_MODEL = 'gpt-6-luna'
$env:HUIYI_CODEX_BRIDGE_URL = $bridgeBase
$env:HUIYI_CODEX_BRIDGE_API_KEY = $bridgeApiKey
$env:HUIYI_DEMO_GATEWAY_PORT = [string]$GatewayPort
$env:HUIYI_DEMO_WEB_PORT = [string]$WebPort
$env:HUIYI_EVAL_WEB_PORT = [string]$WebPort
$env:HUIYI_EVAL_BROWSER_GATEWAY = '1'
$env:HUIYI_EVAL_CHROMIUM_PATH = $browserPath
$env:HUIYI_EVAL_BROWSER_USER = 'browser-smoke'
$env:HUIYI_EVAL_BROWSER_PASSWORD = $password
$resultPath = $null
if ($RunModelChat) {
  $env:HUIYI_HEALTH_ENGINE_URL = $HealthEngineUrl.TrimEnd('/')
  $env:HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = '1'
  $env:HUIYI_DEMO_MAX_TOKENS = '384'
  $env:HUIYI_EVAL_BROWSER_CHAT = '1'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$resultPath = Join-Path $repoRoot "artifacts/clinical-eval/browser-e2e/browser-e2e-$runId.json"
if ($RunModelChat) { $env:HUIYI_EVAL_BROWSER_RESULT_PATH = $resultPath }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$tempBase = Join-Path $env:TEMP ('huiyi-browser-gateway-' + [guid]::NewGuid().ToString('N'))
$stdout = "$tempBase.out.log"
$stderr = "$tempBase.err.log"
  $gateway = Start-Process -FilePath $nodePath -ArgumentList @('--import', 'tsx', 'src/server.ts') `
    -WorkingDirectory (Join-Path $repoRoot 'services/demo-gateway') -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$GatewayPort/api/health" -TimeoutSec 2
      if ($health.status -eq 'ok' -and $health.backend -eq 'dsh' -and
          $health.modelBackend -eq 'codex-app-server' -and $health.modelName -eq 'gpt-6-luna') {
        $ready = $true
        break
      }
    } catch { }
    if ($gateway.HasExited) { throw "Isolated Gateway exited early; inspect $stdout and $stderr." }
  }
  if (-not $ready) { throw "Isolated Gateway failed its local health check; inspect $stdout and $stderr." }

  Push-Location (Join-Path $repoRoot 'apps/demo-web')
  try { & pnpm.cmd run clinical-evaluation:browser-smoke; if ($LASTEXITCODE -ne 0) { throw "Playwright exited with code $LASTEXITCODE." } }
  finally { Pop-Location }
  if ($RunModelChat) {
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { throw 'Model browser E2E passed Playwright without writing its sanitized result artifact.' }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $result | Add-Member -NotePropertyName bridgeMaxConcurrentTurns -NotePropertyValue $bridgeHealth.maxConcurrentTurns
    $result | Add-Member -NotePropertyName healthEngineSourceSha256 -NotePropertyValue $route.healthEngineSourceSha256
    $result | Add-Member -NotePropertyName corpusVersion -NotePropertyValue $ragStatus.corpusVersion
    $result | Add-Member -NotePropertyName corpusChunkCount -NotePropertyValue $ragStatus.chunkCount
    [System.IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 6) + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output "Sanitized browser E2E metrics written to $resultPath"
  }
  $completed = $true
}
finally {
  if ($gateway) {
    $listener = @(Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($entry in $listener) {
      if ($entry.OwningProcess -ne $gateway.Id) {
        $cleanupProblem = "Port $GatewayPort has a listener not owned by this test process (PID $($entry.OwningProcess)); left untouched."
        continue
      }
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($gateway.Id)" -ErrorAction SilentlyContinue
      if ($process -and $process.CommandLine -match 'node.*--import tsx src/server.ts') {
        Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue
      } elseif ($process) {
        $cleanupProblem = "Gateway PID $($gateway.Id) no longer matches the expected command; left untouched."
      }
    }
  }
  $webListeners = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($entry in $webListeners) {
    $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.OwningProcess)" -ErrorAction SilentlyContinue
    if ($webProcess -and $webProcess.CommandLine -match "vite\.js.*--host 127\.0\.0\.1 --port $WebPort --mode clinical-evaluation") {
      Stop-Process -Id $entry.OwningProcess -Force -ErrorAction SilentlyContinue
    } else {
      $cleanupProblem = "Port $WebPort has a listener not matching this test's Vite command (PID $($entry.OwningProcess)); left untouched."
    }
  }
  foreach ($name in $managedEnvironmentVariables) {
    $value = $previousEnvironment[$name]
    if ($null -eq $value) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" -Value $value }
  }
  if ($completed) {
    Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
    Write-Output "isolated Gateway closed; browser and Gateway ports $WebPort/$GatewayPort released"
  } else {
    Write-Output "isolated Gateway cleanup attempted; diagnostic logs retained at $tempBase"
  }
}

$remaining = @(Get-NetTCPConnection -LocalPort $GatewayPort,$WebPort -State Listen -ErrorAction SilentlyContinue)
if ($remaining.Count) {
  $details = ($remaining | ForEach-Object { "$($_.LocalPort)/$($_.OwningProcess)" }) -join ', '
  $cleanupMessages = @()
  if ($cleanupProblem) { $cleanupMessages += $cleanupProblem }
  $cleanupMessages += "A test listener remains: $details"
  $cleanupProblem = $cleanupMessages -join '; '
}
if ($cleanupProblem) { throw $cleanupProblem }
