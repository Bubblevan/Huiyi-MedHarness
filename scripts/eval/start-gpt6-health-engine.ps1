param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8325,
  [ValidateRange(1024, 65535)]
  [int]$BridgePort = 8333,
  [ValidateSet('single', 'iterative')]
  [string]$RagMode = 'single',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$engine = Join-Path $repo 'services/health-engine'
$python = Join-Path $engine '.venv/Scripts/python.exe'
$modelPath = 'E:\Health-Copilot-Models\models\Qwen3-Embedding-0.6B'
$dataRoot = Join-Path $engine 'data/local-rag-hc-rag-002'
$corpusRoot = Join-Path $dataRoot 'corpus'
$manifest = Join-Path $dataRoot 'qwen3-corpus-manifest.json'
$runLabel = Get-Date -Format 'yyyyMMdd-HHmmss'
$memoryRoot = Join-Path $dataRoot "memory-codex-gpt6-synthetic-$runLabel"
$bridgeBase = "http://127.0.0.1:$BridgePort/v1"
$bridgeHealthUrl = "http://127.0.0.1:$BridgePort/healthz"
$bridgeApiKey = 'local-only'
if (-not [string]::IsNullOrWhiteSpace($env:HUIYI_CODEX_BRIDGE_API_KEY)) { $bridgeApiKey = $env:HUIYI_CODEX_BRIDGE_API_KEY }
$chatUrl = "$bridgeBase/chat/completions"

foreach ($path in @($python, $modelPath, $corpusRoot, $manifest)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required local GPT-6 Health Engine asset is missing: $path" }
}
$manifestInfo = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
$sourceNames = @($manifestInfo.sources | ForEach-Object { $_.name })
$chunkCount = ($manifestInfo.sources | Measure-Object -Property chunkCount -Sum).Sum
if ($sourceNames.Count -ne 5 -or $chunkCount -lt 1 -or $manifestInfo.retriever.queryEncoderModel -notmatch 'Qwen3-Embedding') {
  throw 'Qwen3 corpus manifest is not the expected verified five-source embedding index.'
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use; choose another isolated Health Engine port." }

$bridgeModel = 'gpt-6-luna' # the bridge source has a fixed, non-overridable model allowlist
$bridgeHealth = $null
try { $bridgeHealth = Invoke-RestMethod -Uri $bridgeHealthUrl -TimeoutSec 5 } catch { }
$bridgeModels = $null
try { $bridgeModels = Invoke-RestMethod -Uri "$bridgeBase/models" -Headers @{ Authorization = "Bearer $bridgeApiKey" } -TimeoutSec 5 } catch { }
if ($bridgeHealth.status -ne 'ok' -or $bridgeHealth.model -ne $bridgeModel -or
    @($bridgeModels.data | Where-Object { $_.id -eq $bridgeModel }).Count -ne 1) {
  $healthStatus = if ($bridgeHealth) { $bridgeHealth.status } else { 'unavailable' }
  $healthModel = if ($bridgeHealth) { $bridgeHealth.model } else { 'unavailable' }
  $modelIds = if ($bridgeModels) { @($bridgeModels.data | ForEach-Object { $_.id }) -join ',' } else { 'unavailable' }
  throw "Codex bridge check failed: health=$healthStatus, health-model=$healthModel, available-models=$modelIds. Ensure the loopback bridge and HUIYI_CODEX_BRIDGE_API_KEY match."
}

if ($CheckOnly) {
  Write-Output "Validated loopback Codex bridge on port $BridgePort and /models pinned to $bridgeModel, Qwen3-Embedding-0.6B assets, $($sourceNames.Count)-source / $chunkCount-chunk Qwen3 corpus manifest, free Health Engine port $Port, and isolated synthetic memory path. No model generation was requested."
  return
}

New-Item -ItemType Directory -Path $memoryRoot -Force | Out-Null
$env:PYTHONPATH = Join-Path $engine 'src'
$env:HUIYI_HEALTH_ENGINE_HOST = '127.0.0.1'
$env:HUIYI_HEALTH_ENGINE_PORT = [string]$Port
$env:HUIYI_ENABLE_EVALUATION_CONFIG = '1'
$env:HUIYI_MEMORY_DATA_DIR = $memoryRoot
$env:HUIYI_MEMORY_CAPTURE_USAGE = '1'
$env:HUIYI_MEMORY_MODEL_TIMEOUT_SECONDS = '90'
$env:HUIYI_MEMORY_ISOLATE_RECALLS = '1'
$env:HUIYI_MEMORY_LLM_TRACE_FILE = Join-Path $memoryRoot 'codex-model-trace.jsonl'
$env:HUIYI_LOCAL_LLM_BASE_URL = $chatUrl
$env:HUIYI_LOCAL_LLM_MODEL = 'gpt-6-luna'
$env:HUIYI_LOCAL_EMBEDDING_MODEL = 'Qwen3-Embedding-0.6B'
$env:HUIYI_LOCAL_EMBEDDING_PATH = $modelPath
$env:HUIYI_RAG_ENABLED = '1'
$env:HUIYI_RAG_CORPUS_ROOT = $corpusRoot
$env:HUIYI_RAG_MANIFEST_PATH = $manifest
$env:HUIYI_RAG_QUERY_ENCODER_PATH = $modelPath
$env:HUIYI_RAG_RETRIEVER_DEVICE = 'cpu'
$env:HUIYI_RAG_DEFAULT_MODE = $RagMode
$env:HUIYI_RAG_PLANNER_BASE_URL = $chatUrl
$env:HUIYI_RAG_PLANNER_MODEL = 'gpt-6-luna'
$env:HUIYI_RAG_PLANNER_API_KEY = $bridgeApiKey
$env:HUIYI_RAG_PLANNER_MAX_TOKENS = '256'

Write-Output "Starting loopback Health Engine on 127.0.0.1:$Port with RAG mode '$RagMode'. AMA and any iterative RAG planning use GPT-6-Luna at the local Codex bridge on port $BridgePort; Qwen3-Embedding-0.6B is retrieval/embedding only. Synthetic memory is isolated at $memoryRoot."
Push-Location $engine
try {
  & $python -m uvicorn huiyi_health_engine.app:app --host 127.0.0.1 --port $Port --no-access-log
} finally {
  Pop-Location
}
