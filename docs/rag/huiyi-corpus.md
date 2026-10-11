# Huiyi hospital public corpus

This is a public-source snapshot for local retrieval. It is not a patient-record
store and it is not clinical review. Canonical pages about medical education and
FAQs remain marked `NEEDS_HUMAN_REVIEW`; static hospital, department, and doctor
profile facts are marked `AUTO_ACCEPTED_PUBLIC_INFO` without implying clinical
approval.

## Durable paths

The crawler is tracked at `scripts/rag/crawl_huiyi.py`. By default it writes all
local assets under:

```text
services/health-engine/data/local-rag-hc-rag-002/corpus/huiyi/
```

Each run gets a UTC run ID. Raw HTML and normalized/chunk generations are kept
under `raw/runs/<run-id>/`, `normalized/runs/<run-id>/`, and `chunk/runs/<run-id>/`;
`active-run.json` points to the most recent run. The crawler does not delete old
snapshots. Large local assets are ignored by Git; the script and this runbook
are version controlled.

The crawl is limited to `https://yk.huiyi9e.com/`, sends an identifying
User-Agent, checks `robots.txt`, spaces requests, retries a bounded number of
times, and does not submit forms, read cookies, download images, or leave the
host. Hospital, doctor, department, service-flow, patient-education, and FAQ
pages are categorized separately. News, events, schedules, registration, and
insurance pages are retained as raw-only dynamic snapshots and excluded from
the static retrieval index.

## Re-crawl

From the repository root in PowerShell:

```powershell
$python = "services/health-engine/.venv/Scripts/python.exe"
& $python scripts/rag/crawl_huiyi.py
```

Install the optional crawler dependencies if needed:

```powershell
Set-Location services/health-engine
python -m pip install -e ".[huiyi]"
Set-Location ../..
```

The run writes raw-page hashes and HTTP metadata to the run manifest, canonical
documents to the normalized manifest, rejected pages with reasons, exact
duplicate flags, and structure-aware chunks capped by the local MedCPT
tokenizer. `crawl-report.json` and `active-run.json` make the selected run easy
to find after a restart.

The initial 2026-10-10 extraction exposed that this CMS wraps some doctor
article bodies in a `<form>` element. Parser v2 removes form controls but keeps
the readable wrapper, so doctor and department content is retained. The
audited snapshot `20261010T150436.765727Z` contains 85 raw pages, 59 canonical
documents, and 69 chunks, with no fetch failures or rejected documents. It
deduplicated one page whose body exactly matched the hospital introduction.
The documents include 10 doctor profiles, 10 departments, 6 hospital/service
pages, and 33 patient-education/FAQ pages. Education and FAQ chunks retain
`NEEDS_HUMAN_REVIEW`; that marker does not mean a clinician has approved them.
The site's `/robots.txt` returned 404 during this run.

## Build the unified MedCPT index

The active Health Engine loads MedCPT/FAISS indexes from one manifest. Therefore
the Huiyi chunks use the same local MedCPT article encoder as Textbooks,
StatPearls, PubMed, and Wikipedia. This keeps one query encoder contract across
the local corpus. No runtime download or hosted embedding call is used.

```powershell
$repo = (Get-Location).Path
$corpusRoot = Join-Path $repo "services/health-engine/data/local-rag-hc-rag-002/corpus"
$python = Join-Path $repo "services/health-engine/.venv/Scripts/python.exe"
$huiyi = Get-Content (Join-Path $corpusRoot "huiyi/active-run.json") -Raw | ConvertFrom-Json
$huiyiRoot = Join-Path $corpusRoot "huiyi"
$chunkRoot = Join-Path $huiyiRoot $huiyi.chunkRoot
$indexRoot = Join-Path $huiyiRoot ("index/runs/{0}/ncbi/MedCPT-Article-Encoder" -f $huiyi.runId)
& $python scripts/rag/build_index.py --chunk-root $chunkRoot --index-dir $indexRoot --article-encoder-path E:/Health-Copilot-Models/models/MedCPT-Article-Encoder --device cuda --batch-size 8
& $python scripts/rag/prepare_corpus.py --corpus-root $corpusRoot --output (Join-Path (Split-Path $corpusRoot) "corpus-manifest.json") --corpora textbooks statpearls pubmed wikipedia huiyi --textbooks-revision "HC-RAG-002-local-manifest" --statpearls-revision "MedRAG-7599a728a28789fd601728c08d313b1148051f41" --pubmed-revision "MedCorp local snapshot 2026-10-10; 23 available shards" --wikipedia-revision "MedCorp local snapshot 2026-10-10; 5 available shards" --huiyi-revision $huiyi.runId --huiyi-chunk-root $chunkRoot --huiyi-index-root $indexRoot --source-repository "E:/Health-Copilot-Models/MedCorp local snapshot plus https://yk.huiyi9e.com/ public snapshot" --query-encoder-model "ncbi/MedCPT-Query-Encoder" --query-encoder-revision "d83a36cc6b8e3a5c5e9d9d6ba156808c1643dcbc" --article-encoder-model "ncbi/MedCPT-Article-Encoder" --article-encoder-revision "d05a736da4bb84ee4057b7f7999485be6ed85465"
& $python scripts/rag/verify_index.py --corpus-root $corpusRoot --manifest (Join-Path (Split-Path $corpusRoot) "corpus-manifest.json")
```

Milvus is not required for this unified Health Engine path: the service loads
local FAISS indexes. The older HY-DATA-0 plan named `infra/milvus/` and
`runs/huiyi/hy-data-0/`, but those artifacts were not present in either local
checkout when audited. This runbook and the run-specific paths above prevent
future snapshots from being scattered or mistaken for a Milvus collection.

## Chinese retrieval with Qwen3-Embedding

The initial unified MedCPT snapshot contains 823,450 indexed chunks from all
five sources. Its encoder is a PubMed retrieval model and its tokenizer maps
many Chinese query characters to `[UNK]`; the index can load successfully while
Chinese retrieval returns unrelated passages. Keep that verified MedCPT
manifest available, but use the local multilingual Qwen3-Embedding-0.6B model
when the active workload includes Chinese queries. This is an embedding model;
it does not generate answers.

The Qwen builder streams rows in small GPU batches and writes one FAISS index
per corpus. On this 4090 Laptop the build uses batch size 8 to share VRAM with
the existing local services. It truncates embedded passages to 512 tokens.
Indexes live alongside each prepared corpus, leaving MedCPT assets untouched.

```powershell
$repo = (Get-Location).Path
$engine = Join-Path $repo "services/health-engine"
$corpusRoot = Join-Path $engine "data/local-rag-hc-rag-002/corpus"
$python = Join-Path $engine ".venv/Scripts/python.exe"
$model = "E:/Health-Copilot-Models/models/Qwen3-Embedding-0.6B"
foreach ($name in @("textbooks", "statpearls", "pubmed", "wikipedia")) {
  & $python scripts/rag/build_qwen3_index.py --chunk-root (Join-Path $corpusRoot "$name/chunk") --index-dir (Join-Path $corpusRoot "$name/index/Qwen3-Embedding-0.6B") --model-path $model --device cuda --batch-size 8 --max-length 512
  if ($LASTEXITCODE -ne 0) { throw "Qwen3 index build failed for $name" }
}
$huiyi = Get-Content (Join-Path $corpusRoot "huiyi/active-run.json") -Raw | ConvertFrom-Json
$huiyiRoot = Join-Path $corpusRoot "huiyi"
$huiyiChunkRoot = Join-Path $huiyiRoot $huiyi.chunkRoot
$huiyiIndexRoot = Join-Path $huiyiRoot ("index/runs/{0}/Qwen3-Embedding-0.6B" -f $huiyi.runId)
& $python scripts/rag/build_qwen3_index.py --chunk-root $huiyiChunkRoot --index-dir $huiyiIndexRoot --model-path $model --device cuda --batch-size 8 --max-length 512
if ($LASTEXITCODE -ne 0) { throw "Qwen3 index build failed for Huiyi" }
& $python scripts/rag/prepare_corpus.py --corpus-root $corpusRoot --output (Join-Path (Split-Path $corpusRoot) "qwen3-corpus-manifest.json") --corpora textbooks statpearls pubmed wikipedia huiyi --textbooks-revision "HC-RAG-002-local-manifest" --statpearls-revision "MedRAG-7599a728a28789fd601728c08d313b1148051f41" --pubmed-revision "MedCorp local snapshot 2026-10-10; 23 available shards" --wikipedia-revision "MedCorp local snapshot 2026-10-10; 5 available shards" --huiyi-revision $huiyi.runId --huiyi-chunk-root $huiyiChunkRoot --huiyi-index-root $huiyiIndexRoot --source-repository "E:/Health-Copilot-Models/MedCorp local snapshot plus https://yk.huiyi9e.com/ public snapshot" --query-encoder-model "Qwen/Qwen3-Embedding-0.6B" --query-encoder-revision "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3" --article-encoder-model "Qwen/Qwen3-Embedding-0.6B" --article-encoder-revision "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3" --retriever-name "Qwen3-Embedding-0.6B" --index-subdirectory "index/Qwen3-Embedding-0.6B"
& $python scripts/rag/verify_index.py --corpus-root $corpusRoot --manifest (Join-Path (Split-Path $corpusRoot) "qwen3-corpus-manifest.json")
```

To select the Qwen3 manifest at runtime, set
`HUIYI_RAG_MANIFEST_PATH` to `qwen3-corpus-manifest.json` and
`HUIYI_RAG_QUERY_ENCODER_PATH` to the same local Qwen3-Embedding model path.
`HUIYI_RAG_RETRIEVER_DEVICE=cuda` enables GPU query encoding. The existing
Health Engine RAG service selects the encoder from the manifest, so MedCPT and
Qwen3 manifests can be switched without moving corpus data or overwriting the
other index. The 2026-10-10 smoke index and manifest under the ignored data
directory are temporary Huiyi-only validation artifacts, not the unified
five-source manifest.
