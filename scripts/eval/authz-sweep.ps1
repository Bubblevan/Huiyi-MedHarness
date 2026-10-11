param(
  [ValidateRange(1, 10000)]
  [int]$PatientCount = 300,
  [ValidateRange(1, 20)]
  [int]$EncounterCount = 3,
  [string]$BaseUrl = 'http://127.0.0.1:8321',
  [string]$Origin = 'http://127.0.0.1:5173'
)

$ErrorActionPreference = 'Stop'
$baseUri = [Uri]$BaseUrl
if ($baseUri.Scheme -ne 'http' -or $baseUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment) {
  throw 'The authorization sweep only accepts a plain HTTP loopback Gateway URL.'
}
if ($Origin -notin @('http://127.0.0.1:5173', 'http://localhost:5173')) {
  throw 'The authorization sweep only accepts the local clinical-evaluation web origin.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sourcePaths = @(
  'scripts/eval/authz-sweep.ps1',
  'services/demo-gateway/src/server.ts',
  'services/demo-gateway/src/app-mode.ts',
  'services/demo-gateway/src/backends/dsh-runtime.ts',
  'services/demo-gateway/src/clinical-evaluation/auth.ts',
  'services/demo-gateway/src/clinical-evaluation/dataset.ts',
  'services/demo-gateway/src/clinical-evaluation/sessions.ts'
)
$sourceFiles = @($sourcePaths | Sort-Object | ForEach-Object {
  $absolutePath = Join-Path $repoRoot $_
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) { throw "Required source file is missing: $_" }
  $file = Get-Item -LiteralPath $absolutePath
  [ordered]@{ path = $_; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$sourceManifest = ($sourceFiles | ForEach-Object { "$($_.path)`t$($_.bytes)`t$($_.sha256)" }) -join "`n"
$sourceFingerprint = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($sourceManifest))).ToLowerInvariant()
$gitRevision = (& git -C $repoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
if (-not $gitRevision) { throw 'Unable to resolve the source Git revision for the authorization report.' }
$relevantSourceChanges = @(& git -C $repoRoot status --porcelain -- $sourcePaths 2>$null)

$users = @(
  @{ username = $env:HUIYI_AUTHZ_SWEEP_USER_A; password = $env:HUIYI_AUTHZ_SWEEP_PASSWORD_A; group = 'a' },
  @{ username = $env:HUIYI_AUTHZ_SWEEP_USER_B; password = $env:HUIYI_AUTHZ_SWEEP_PASSWORD_B; group = 'b' }
)
if ($users | Where-Object { [string]::IsNullOrWhiteSpace($_.username) -or [string]::IsNullOrWhiteSpace($_.password) }) {
  throw 'Set two local synthetic account usernames and passwords in HUIYI_AUTHZ_SWEEP_USER_A/B and HUIYI_AUTHZ_SWEEP_PASSWORD_A/B.'
}

function Invoke-HttpStatus {
  param([hashtable]$Request)
  try {
    $response = Invoke-WebRequest @Request -TimeoutSec 10 -ErrorAction Stop
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response -and $null -ne $_.Exception.Response.StatusCode) {
      return [int]$_.Exception.Response.StatusCode
    }
    throw
  }
}

function Get-ResourceSnapshot {
  $os = Get-CimInstance Win32_OperatingSystem
  $disks = @{}
  Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:' OR DeviceID='D:' OR DeviceID='E:'" | ForEach-Object {
    $disks[$_.DeviceID] = [Math]::Round($_.FreeSpace / 1GB, 1)
  }
  return [ordered]@{
    ramFreeGiB = [Math]::Round($os.FreePhysicalMemory / 1MB, 1)
    ramTotalGiB = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    diskFreeGiB = $disks
  }
}

$health = Invoke-RestMethod "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/health" -TimeoutSec 5
if ($health.status -ne 'ok' -or $health.backend -ne 'dsh' -or $health.modelBackend -ne 'codex-app-server' -or $health.modelName -ne 'gpt-6-luna') {
  throw 'Gateway health must attest DSH + Codex app-server + gpt-6-luna before the sweep.'
}

$before = Get-ResourceSnapshot
$started = [DateTime]::UtcNow
$cookies = @{}
$latencies = [System.Collections.Generic.List[double]]::new()
$observedAllowed = 0
$observedDenied = 0
$unauthorizedSuccesses = 0
$unexpectedStatuses = 0
$loginStatuses = [System.Collections.Generic.List[int]]::new()
$logoutStatuses = [System.Collections.Generic.List[int]]::new()
$postLogoutStatuses = [System.Collections.Generic.List[int]]::new()
$accountResults = [System.Collections.Generic.List[object]]::new()
$sessionChecks = @{}
$timer = [System.Diagnostics.Stopwatch]::StartNew()

try {
  foreach ($user in $users) {
    $cookie = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $login = Invoke-RestMethod "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/auth/login" -Method Post -Headers @{ Origin = $Origin } -ContentType 'application/json' -Body (@{ username = $user.username; password = $user.password } | ConvertTo-Json -Compress) -WebSession $cookie -TimeoutSec 10
    $loginStatuses.Add($(if ($login.authenticated) { 200 } else { 0 }))
    $cookies[$user.group] = $cookie
    $listed = Invoke-RestMethod "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/patients" -WebSession $cookie -TimeoutSec 10
    $listedCount = @($listed.patients).Count
    $allowed = 0
    $denied = 0
    $expectedScoped = 0
    for ($index = 1; $index -le $PatientCount; $index++) {
      $patientId = 'SYN-P-{0:D4}' -f $index
      $encounterId = 'SYN-{0:D4}-ENC-{1:D2}' -f $index, $EncounterCount
      $expectedAllowed = $index % 2 -eq 1 -and (($index % 4 -eq 1 -and $user.group -eq 'a') -or ($index % 4 -eq 3 -and $user.group -eq 'b'))
      if ($expectedAllowed) { $expectedScoped++ }
      $watch = [System.Diagnostics.Stopwatch]::StartNew()
      $status = Invoke-HttpStatus @{ Uri = "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/patients/$patientId/context?encounterId=$encounterId"; Method = 'Get'; WebSession = $cookie }
      $watch.Stop()
      $latencies.Add($watch.Elapsed.TotalMilliseconds)
      if ($status -eq 200) {
        $observedAllowed++
        $allowed++
        if (-not $expectedAllowed) { $unauthorizedSuccesses++ }
      } elseif ($status -eq 404) {
        $observedDenied++
        $denied++
        if ($expectedAllowed) { $unexpectedStatuses++ }
      } else {
        $unexpectedStatuses++
      }
    }
    $accountResults.Add([ordered]@{ listedPatients = $listedCount; expectedScopedPatients = $expectedScoped; contextReadsAllowed = $allowed; outOfScopeReadsDenied = $denied })
  }

  $session = Invoke-RestMethod "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/sessions" -Method Post -Headers @{ Origin = $Origin } -ContentType 'application/json' -Body (@{ patientId = 'SYN-P-0001'; encounterId = 'SYN-0001-ENC-03' } | ConvertTo-Json -Compress) -WebSession $cookies['a'] -TimeoutSec 10
  $sessionChecks.crossAccountDeleteStatus = Invoke-HttpStatus @{ Uri = "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/sessions/$($session.sessionId)"; Method = 'Delete'; Headers = @{ Origin = $Origin }; WebSession = $cookies['b'] }
  $sessionChecks.ownerDeleteStatus = Invoke-HttpStatus @{ Uri = "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/sessions/$($session.sessionId)"; Method = 'Delete'; Headers = @{ Origin = $Origin }; WebSession = $cookies['a'] }
} finally {
  foreach ($group in @('a', 'b')) {
    if ($cookies[$group]) {
      $logoutStatuses.Add((Invoke-HttpStatus @{ Uri = "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/auth/logout"; Method = 'Post'; Headers = @{ Origin = $Origin }; ContentType = 'application/json'; Body = '{}'; WebSession = $cookies[$group] }))
      $postLogoutStatuses.Add((Invoke-HttpStatus @{ Uri = "$($baseUri.AbsoluteUri.TrimEnd('/'))/api/patients"; Method = 'Get'; WebSession = $cookies[$group] }))
    }
  }
}

$latencySorted = @($latencies | Sort-Object)
$p95Index = [Math]::Max(0, [Math]::Ceiling($latencySorted.Count * 0.95) - 1)
$p95 = if ($latencySorted.Count) { [Math]::Round($latencySorted[$p95Index], 2) } else { $null }
$after = Get-ResourceSnapshot
$timer.Stop()
$datasetSeed = if ([string]::IsNullOrWhiteSpace($env:HUIYI_EVAL_DATASET_SEED)) { 'huiyi-clinical-evaluation-v1' } else { $env:HUIYI_EVAL_DATASET_SEED.Trim() }
$result = [ordered]@{
  schemaVersion = '1.1.0'
  measuredAt = $started.ToString('o')
  durationMs = [Math]::Round($timer.Elapsed.TotalMilliseconds, 2)
  status = if ($unauthorizedSuccesses -eq 0 -and $unexpectedStatuses -eq 0 -and $sessionChecks.crossAccountDeleteStatus -eq 404 -and $sessionChecks.ownerDeleteStatus -eq 204 -and @($postLogoutStatuses | Where-Object { $_ -ne 401 }).Count -eq 0) { 'pass' } else { 'fail' }
  scope = 'local synthetic clinical-evaluation Gateway; not production identity or EMR authorization'
  syntheticOnly = $true
  sourceAttestation = [ordered]@{
    gitRevision = $gitRevision.Trim()
    relevantSourceDirty = ($relevantSourceChanges.Count -gt 0)
    fingerprintAlgorithm = 'sha256(path + byte length + file sha256, sorted by path)'
    fingerprintSha256 = $sourceFingerprint
    files = $sourceFiles
  }
  routeAttestation = [ordered]@{ backend = $health.backend; modelBackend = $health.modelBackend; model = $health.modelName }
  cohort = [ordered]@{ patientCount = $PatientCount; encounterCount = $EncounterCount; datasetSeed = $datasetSeed; accounts = 2; plannedContextChecks = 2 * $PatientCount }
  observed = [ordered]@{
    loginSuccesses = @($loginStatuses | Where-Object { $_ -eq 200 }).Count
    scopedPatientCounts = @($accountResults | ForEach-Object { $_.listedPatients })
    allowedContextReads = $observedAllowed
    outOfScopeContextReadsDenied = $observedDenied
    unauthorizedContextSuccesses = $unauthorizedSuccesses
    unexpectedStatuses = $unexpectedStatuses
    contextReadP95Ms = $p95
    sessionOwnership = $sessionChecks
    logoutStatuses = @($logoutStatuses)
    protectedPatientListAfterLogoutStatuses = @($postLogoutStatuses)
    modelGenerationRequests = 0
  }
  resources = [ordered]@{ before = $before; after = $after }
  limitations = @('synthetic in-memory evaluation accounts and records only', 'does not prove production SSO, database row-level security, cross-device revocation, or clinical safety')
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputDirectory = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'artifacts/clinical-eval/authz-sweeps'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$outputPath = Join-Path $outputDirectory "authz-sweep-$stamp.json"
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding utf8
Write-Output ($result | ConvertTo-Json -Depth 8)
Write-Output "artifact=$outputPath"
if ($result.status -ne 'pass') { exit 1 }
