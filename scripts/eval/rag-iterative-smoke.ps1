param(
  [string]$BaseUrl = 'http://127.0.0.1:8325',
  [ValidateSet('english', 'chinese', 'bilingual')]
  [string]$Profile = 'english',
  [ValidateSet('single', 'iterative')]
  [string]$Mode = 'iterative'
)

$ErrorActionPreference = 'Stop'
$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1', 'localhost', '::1') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
  throw 'The RAG smoke only accepts a plain HTTP loopback Health Engine URL.'
}
$base = $uri.AbsoluteUri.TrimEnd('/')
$engineConfig = Invoke-RestMethod "$base/_internal/evaluation/config" -TimeoutSec 5
$ragStatus = Invoke-RestMethod "$base/v1/rag/status" -TimeoutSec 5
if ($engineConfig.amaModel -ne 'gpt-6-luna' -or $engineConfig.ragPlannerModel -ne 'gpt-6-luna' -or
    $engineConfig.ragPlannerEndpoint -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\]):\d+/v1/chat/completions$' -or
    -not $engineConfig.ragEnabled -or $ragStatus.status -ne 'ready' -or
    $ragStatus.retrieverName -ne 'Qwen3-Embedding-0.6B' -or $ragStatus.sourceCount -ne 5) {
  throw 'Health Engine is not attested to GPT-6-Luna planning with the ready five-source Qwen3 index.'
}

function Get-ResourceSnapshot {
  $os = Get-CimInstance Win32_OperatingSystem
  $disks = @{}
  Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:' OR DeviceID='D:' OR DeviceID='E:'" | ForEach-Object {
    $disks[$_.DeviceID] = [Math]::Round($_.FreeSpace / 1GB, 1)
  }
  $gpu = $null
  $gpuLine = & nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>$null
  if ($LASTEXITCODE -eq 0 -and $gpuLine) {
    $parts = @($gpuLine -split ',')
    if ($parts.Count -ge 4) {
      $gpu = [ordered]@{ name = $parts[0].Trim(); memoryUsed = $parts[1].Trim(); memoryTotal = $parts[2].Trim(); utilization = $parts[3].Trim() }
    }
  }
  return [ordered]@{
    ramFreeGiB = [Math]::Round($os.FreePhysicalMemory / 1MB, 1)
    ramTotalGiB = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    diskFreeGiB = $disks
    gpu = $gpu
  }
}

$queries = @()
if ($Profile -in @('english', 'bilingual')) {
  $queries += [ordered]@{
    id = 'adult-hypertension-home-bp-en'
    language = 'en'
    text = 'For adult hypertension follow-up, what evidence should be considered when evaluating home blood pressure measurement and medication adherence?'
  }
}
if ($Profile -in @('chinese', 'bilingual')) {
  $queries += [ordered]@{
    id = 'adult-hypertension-home-bp-zh-hans'
    language = 'zh-Hans'
    text = '成人高血压复诊中，评估居家血压测量和用药依从性时，应参考哪些医学证据？'
  }
}

$before = Get-ResourceSnapshot
$measuredAt = [DateTime]::UtcNow
$results = foreach ($spec in $queries) {
  $queryHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($spec.text))).ToLowerInvariant()
  try {
    $response = Invoke-RestMethod "$base/v1/rag/search" -Method Post -ContentType 'application/json' -Body (@{ query = $spec.text; mode = $Mode; topK = 3 } | ConvertTo-Json -Compress) -TimeoutSec 190
    $metrics = $response.retrieval
    $modePassed = if ($Mode -eq 'iterative') {
      $response.mode -eq 'iterative' -and $metrics.plannerCalls -gt 0
    } else {
      $response.mode -eq 'single' -and $metrics.plannerCalls -eq 0
    }
    $passed = $modePassed -and $metrics.retrievalCalls -gt 0 -and
      $metrics.returnedEvidenceCount -gt 0 -and -not $metrics.degraded -and $metrics.plannerModel -eq 'gpt-6-luna'
    [ordered]@{
      id = $spec.id
      language = $spec.language
      status = if ($passed) { 'pass' } else { 'fail' }
      queryLength = $spec.text.Length
      querySha256 = $queryHash
      requestedMode = $Mode
      mode = $response.mode
      rounds = $metrics.rounds
      generatedQueries = $metrics.generatedQueries
      generatedQueryHashesCount = @($metrics.generatedQueryHashes).Count
      retrievalCalls = $metrics.retrievalCalls
      plannerCalls = $metrics.plannerCalls
      candidateCount = $metrics.candidateCount
      uniqueDocuments = $metrics.uniqueDocuments
      returnedEvidenceCount = $metrics.returnedEvidenceCount
      retrievalLatencyMs = $metrics.retrievalLatencyMs
      plannerLatencyMs = $metrics.plannerLatencyMs
      totalLatencyMs = $metrics.latencyMs
      plannerModel = $metrics.plannerModel
      plannerPromptVersion = $metrics.plannerPromptVersion
      plannerInputTokens = $metrics.plannerInputTokens
      plannerOutputTokens = $metrics.plannerOutputTokens
      estimatedContextTokens = $metrics.estimatedContextTokens
      degraded = $metrics.degraded
      degradedErrorClass = $metrics.degradedErrorClass
      corpusVersion = $response.corpusVersion
      returnedCorpora = @($response.hits | ForEach-Object { $_.corpus } | Select-Object -Unique)
      modelGenerationRequests = 0
      answerGenerationRequests = 0
    }
  } catch {
    [ordered]@{
      id = $spec.id
      language = $spec.language
      status = 'error'
      queryLength = $spec.text.Length
      querySha256 = $queryHash
      requestedMode = $Mode
      failureClass = $_.Exception.GetType().Name
      modelGenerationRequests = 0
      answerGenerationRequests = 0
    }
  }
}
$after = Get-ResourceSnapshot
$passedCount = @($results | Where-Object status -eq 'pass').Count
$reportStatus = if ($passedCount -eq $queries.Count) { 'pass' } elseif ($passedCount -gt 0) { 'partial' } else { 'fail' }
$report = [ordered]@{
  schemaVersion = '1.2.0'
  measuredAt = $measuredAt.ToString('o')
  profile = $Profile
  mode = $Mode
  status = $reportStatus
  queryCount = $queries.Count
  passedQueryCount = $passedCount
  scope = if ($Mode -eq 'iterative') { 'loopback iterative retrieval planning over fixed generic medical queries; no patient data and no answer generation' } else { 'loopback single-pass vector retrieval over fixed generic medical queries; no patient data and no model generation' }
  modelGenerationRequests = 0
  route = [ordered]@{ plannerModel = $engineConfig.ragPlannerModel; plannerEndpoint = $engineConfig.ragPlannerEndpoint; embeddingModel = $engineConfig.embeddingModel }
  corpus = [ordered]@{ version = $ragStatus.corpusVersion; sourceCount = $ragStatus.sourceCount; chunkCount = $ragStatus.chunkCount }
  results = @($results)
  resources = [ordered]@{ before = $before; after = $after }
  limitation = 'retrieval and planner routing only; evidence relevance/support and clinical accuracy were not adjudicated'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$directory = Join-Path $root 'artifacts/clinical-eval/rag-smokes'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$path = Join-Path $directory "rag-$Mode-$stamp.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding utf8
Write-Output ($report | ConvertTo-Json -Depth 8)
Write-Output "artifact=$path"
if ($reportStatus -ne 'pass') { exit 1 }
