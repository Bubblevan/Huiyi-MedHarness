# HC-MEM-002 LoCoMo parity evaluation

This directory defines one frozen evaluation profile for the same Huiyi memory implementation in three arms. It does not change product defaults. The exact settings, known provenance gaps, dataset hash, category counts, and paper targets are in [manifest.json](./manifest.json).

The recovered local AMA reproduction consists of four explicitly labeled smoke runs under `/root/gpufree-data/AMA/runs/`. Three stopped before a complete QA result; one contains a single construction item and one category-2 QA item. No full local AMA predictions or category metrics were found. Those runs are recorded as smoke evidence and are not used as a parity baseline.

All data, state, predictions, pairwise diffs, and runtime traces are written under `artifacts/hc-mem-002/`, which is ignored by Git. The LoCoMo source file is not copied into this repository. Its SHA256 is checked against the frozen manifest before construction and scoring.

## Fixed protocol

- Build one AMA store with the pinned `evalProcess.py` lifecycle: every session dialogue item goes through `AMA.forwardUser`; `judgeAndGenerate()` runs once at each session boundary.
- Use local `Qwen/Qwen3-8B` for AMA internal calls and QA. Use the local `Qwen3-Embedding-0.6B` CPU embedder.
- Use `strongRetrieve=true`, `turnRetrieve=3`, `topK=10`, and temperature 0 for each QA arm. Construction uses pinned AMA's default `turnRetrieve=1`.
- Exclude category 5 exactly. The included question IDs are single-hop 282, multi-hop 96, temporal 321, and open-domain 841.
- Run A, B, and C against independent byte-identical copies of one frozen memory state. Arm C creates a fresh in-memory DSH session for each question and uses the read-only Memory lifecycle.
- The DSH composition mounts only core Session, Agent, AgentLoop, local Qwen, and automatic Huiyi Memory. It does not install the evidence capability or manual memory tools. Benchmark health-engine processes enable `HUIYI_MEMORY_ISOLATE_RECALLS=1`, clearing AMA's transient `memoryWindow` before and after each question so one QA item cannot affect the next.
- The LoCoMo projection preserves AMA's `dia_id` as the optional `MemoryItem.sourceId` and renders it as the benchmark's `dia_id` citation reference. AMA SQLite row IDs, FAISS IDs, ranks, and scores remain excluded. The normal product memory prompt does not render `sourceId`.
- `A_UPSTREAM` and `B_SIDECAR` use the pinned official `QANemoriPrompt`. `C_DSH` splits that same template at the memory placeholder: stable instructions use the DSH system-prompt section, while retrieved memory, question, and output contract travel in the lifecycle's dynamic MemorySnapshot context. The actual question remains a normal DSH user message. Product prompts are unchanged.
- Only Token-F1 and BLEU-1 are scored. The full local reproduction judge could not be recovered, so no LLM judge score is claimed. The paper's GPT-4o-mini score remains an external reference.

## Environment

The Health-Copilot Python 3.13 environment has FastAPI and NumPy but does not have `faiss`; the existing AMA Python 3.12 environment already has the pinned AMA and health-engine dependencies. Use that environment directly so evaluation does not install or modify packages:

```bash
export PYTHON=/root/gpufree-data/AMA/.venv/bin/python
export HUIYI_LOCAL_LLM_MODEL=Qwen3-8B
export HUIYI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8000/v1/chat/completions
export AMA_EMBEDDING_URL=http://127.0.0.1:8322/_internal/ama/embeddings
export LOCOMO_DATASET=/root/gpufree-share/data/locomo-mc10/raw/locomo10.json
```

The HC-MEM-003 run starts one loopback vLLM process only after the neighboring GPU workload releases the L40. It serves the pinned Qwen3-8B snapshot on port 8000 with the contract's vLLM build, served model name, 16,384-token context, BF16 dtype, 0.8 GPU memory budget, eager mode, seed, and disabled thinking. The endpoint is checked before every arm. Reuse this one endpoint for A, B, C, and AMA internal calls. If it is unavailable, re-check GPU/cgroup resources and serving-process ownership before starting anything.

The canonical model identity is `Qwen/Qwen3-8B`; its server alias is `Qwen3-8B`. This distinction matters because the local vLLM process accepts only the configured served alias. AMA internal calls, standalone A/B answers, and the DSH adapter all send that same alias. The embedding endpoint remains the existing loopback health-engine. Do not use a hosted model route. Every evaluation runner verifies the dataset hash, model identity, served model/context, loopback URLs, and frozen-state hashes before evaluating.

Before model startup, re-check the current GPU, cgroup memory, disk space/inodes, and listening ports. Use separate health-engine processes and data directories for construction, B, and C. Do not stop the accepted product health-engine process on port 8322. Example benchmark sidecar profiles:

```bash
HUIYI_HEALTH_ENGINE_HOST=127.0.0.1 \
HUIYI_HEALTH_ENGINE_PORT=8324 \
HUIYI_HEALTH_ENGINE_URL=http://127.0.0.1:8324 \
HUIYI_LOCAL_LLM_MODEL=Qwen3-8B \
HUIYI_MEMORY_DATA_DIR=/root/gpufree-data/Huiyi-MedHarness/artifacts/hc-mem-002/arm-b-sidecar/state \
HUIYI_MEMORY_TURN_RETRIEVE=3 HUIYI_MEMORY_TOP_K=10 HUIYI_MEMORY_CAPTURE_USAGE=1 HUIYI_MEMORY_ISOLATE_RECALLS=1 \
PYTHONPATH=/root/gpufree-data/Huiyi-MedHarness/services/health-engine/src \
  $PYTHON -m uvicorn huiyi_health_engine.app:app --host 127.0.0.1 --port 8324 --no-access-log
```

For Arm C use port `8325` and `arm-c-dsh/state`. Use the existing AMA Python environment for the health-engine process so this run does not install dependencies into either project.

## Build and freeze the common store

The construction script checkpoints only complete LoCoMo sessions. It redirects upstream AMA output so dialogue content does not reach terminal logs. A resumed build checks the dataset hash and discards an incomplete session copy rather than replaying a partially written session into the durable store.

```bash
export PYTHONPATH="$PWD/eval/memory/locomo:$PWD/services/health-engine/src"
$PYTHON eval/memory/locomo/build_reference_store.py --max-sessions 30
$PYTHON eval/memory/locomo/build_reference_store.py --max-sessions 30 --finalize
```

For the initial diagnostic run, use `--max-sessions 30` on both commands. This freezes the first 30 sessions in dataset order: all 19 sessions of `conv-26` and the first 11 sessions of `conv-30`. The arms then evaluate the same 233 non-category-5 questions from those two conversations. Since `conv-30` is only partially constructed, this run exercises the complete A/B/C flow and checks integration parity; its absolute QA scores are diagnostic-only and are not a full LoCoMo result or paper comparison. The frozen-state manifest records the partial scope, selected sessions, and included conversations. Resume and finalize with the same `--max-sessions` value.

Copy `frozen-state/` byte-for-byte into:

```text
artifacts/hc-mem-002/arm-a-upstream/state/
artifacts/hc-mem-002/arm-b-sidecar/state/
artifacts/hc-mem-002/arm-c-dsh/state/
```

Copy `frozen-state/` into each `state/` directory with `cp -a frozen-state/. <arm>/state/`. Each runner checks all files against `frozen-state-manifest.json` before its first recall and derives question IDs from that manifest's conversation scope. The A/B comparison requires the complete scoped question cohort and reports the selected-session scope; partial-store metrics remain diagnostic-only.

## Run arms in order

Run each arm against the exact common state copy. Arm A and B must finish and be compared before Arm C starts.

```bash
$PYTHON eval/memory/locomo/run_upstream.py
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-002/arm-a-upstream/predictions.jsonl
$PYTHON eval/memory/locomo/run_sidecar.py --memory-url http://127.0.0.1:8324
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-002/arm-b-sidecar/predictions.jsonl
$PYTHON eval/memory/locomo/compare.py --ab-only
```

After A↔B parity is resolved, run the real DSH path (the script uses the installed pinned DSH services, not a mock AgentLoop):

```bash
PATH=/root/.nvm/versions/node/v22.23.3/bin:$PATH \
  node --experimental-strip-types eval/memory/locomo/run_dsh.mjs \
    --memoryUrl http://127.0.0.1:8325
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-002/arm-c-dsh/predictions.jsonl
$PYTHON eval/memory/locomo/compare.py
```

Each runner appends completed questions and skips them on restart. `--limit N` is only for a labeled debug prefix and must never be passed to the full evaluation. A/B/C must have identical ordered question IDs before scoring/comparison.

Arm C records a DSH `max-tokens` turn as an evaluation failure with an empty scored answer, the partial raw completion, usage, and trace metadata. It does not treat a partial assistant stream as a final answer, and the read-only lifecycle performs no memory commit for that turn. Other non-completed turn reasons stop the runner for diagnosis.

## Metrics and cost

`score.py` mirrors the pinned AMA evaluator's Token-F1 tokenizer and smoothed BLEU-1 definition. Exact prompt/completion counts are taken from the local OpenAI-compatible responses. The health-engine benchmark profile forces AMA `showUsage` on internally while capturing token counters; no memory text is added to generic traces. `run_dsh.mjs` records prompt/completion counts, model-step count, one-recall count, and metadata-only turn timing. The UTF-8 memory token estimate is retained only as a clearly labeled diagnostic and is not compared with model token usage.

Run warm steady-state comparisons with the same local model process. Cold process startup time must be recorded separately if a cold service run is measured. The recovered reference did not include comparable latency or complete token accounting.

## Interpretation

Gate A→B isolates health-engine adapter normalization/configuration. Gate B→C isolates DSH lifecycle and prompt projection. The principal parity tolerances are absolute 0.01 for overall Token-F1 and BLEU-1. Report category-level changes for all four included categories; any category decline worse than 0.05 absolute on either metric is a material regression even if the overall gate passes. If an A→B gate fails, inspect `paired-diff.jsonl` and fix only demonstrated adapter/configuration losses before starting C.

Do not call the one-question local smoke a benchmark. Do not claim the local result is numerically equal to the paper's GPT-4o-mini judge score.

## HC-MEM-003 full benchmark

HC-MEM-003 keeps the HC-MEM-002 30-session store and its predictions unchanged. Its full-store contract is [manifest-hc-mem-003.json](./manifest-hc-mem-003.json); the bounded P0 cap check uses [manifest-hc-mem-003-preflight.json](./manifest-hc-mem-003-preflight.json) with the old diagnostic store. The full contract freezes all 10 conversations, 272 sessions, 5,882 dialogue items, 1,540 scored questions, category-5 exclusion, Qwen and embedding revisions, and a shared `max_tokens=256` for A/B/C.

The local vLLM endpoint on port 8000 must be reused only after checking that its model root and revision match the contract and that no concurrent GPU job is using it. Do not start a second vLLM service to run this evaluation. The HC-MEM-003 environment is:

```bash
export PYTHON=/root/gpufree-data/AMA/.venv/bin/python
export PYTHONPATH="$PWD/eval/memory/locomo:$PWD/services/health-engine/src"
export HC_MEM_ARTIFACT_DIR="$PWD/artifacts/hc-mem-003"
export HC_MEM_CONTRACT="$PWD/eval/memory/locomo/manifest-hc-mem-003.json"
export HC_MEM_STATE_NAME=frozen-state-full
export HUIYI_LOCAL_LLM_MODEL=Qwen3-8B
export HUIYI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8000/v1/chat/completions
export LOCOMO_DATASET=/root/gpufree-share/data/locomo-mc10/raw/locomo10.json
```

For every memory service used by HC-MEM-003, set `HUIYI_LOCAL_EMBEDDING_MODEL=Qwen3-Embedding-0.6B` and `HUIYI_LOCAL_EMBEDDING_PATH=/root/gpufree-share/models/Qwen3-Embedding-0.6B`. The runner probes the selected service's `/_internal/ama/embeddings` endpoint and rejects a wrong model name, a non-3072-wide vector, or non-finite output before any QA/construction work.

### P0 common-cap preflight

Run this bounded check before full-store construction. It uses fresh byte copies of the immutable HC-MEM-002 30-session stores, and writes all preflight state/predictions only under HC-MEM-003 `preflight/`. Make the copies first:

```bash
mkdir -p artifacts/hc-mem-003/preflight/arm-a-upstream \
  artifacts/hc-mem-003/preflight/arm-b-sidecar artifacts/hc-mem-003/preflight/arm-c-dsh
cp -a artifacts/hc-mem-002/arm-a-upstream/state \
  artifacts/hc-mem-003/preflight/arm-a-upstream/state
cp -a artifacts/hc-mem-002/arm-b-sidecar/state \
  artifacts/hc-mem-003/preflight/arm-b-sidecar/state
cp -a artifacts/hc-mem-002/arm-c-dsh/state \
  artifacts/hc-mem-003/preflight/arm-c-dsh/state
```

Start the benchmark health-engine on port 8324 with the matching embedding model path, B's preflight copy and an external ledger. The service's embedding-only probe does not read or mutate the state store; B uses the same process for its normal `/v1/memory/recall` call.

```bash
HUIYI_HEALTH_ENGINE_HOST=127.0.0.1 \
HUIYI_HEALTH_ENGINE_PORT=8324 \
HUIYI_LOCAL_LLM_MODEL=Qwen3-8B \
HUIYI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8000/v1/chat/completions \
HUIYI_LOCAL_EMBEDDING_MODEL=Qwen3-Embedding-0.6B \
HUIYI_LOCAL_EMBEDDING_PATH=/root/gpufree-share/models/Qwen3-Embedding-0.6B \
HUIYI_MEMORY_DATA_DIR="$PWD/artifacts/hc-mem-003/preflight/arm-b-sidecar/state" \
HUIYI_MEMORY_LEDGER_PATH="$PWD/artifacts/hc-mem-003/preflight/sidecar-ledger.sqlite" \
HUIYI_MEMORY_TURN_RETRIEVE=3 HUIYI_MEMORY_TOP_K=10 \
HUIYI_MEMORY_CAPTURE_USAGE=1 HUIYI_MEMORY_ISOLATE_RECALLS=1 \
HUIYI_RAG_ENABLED=0 HUIYI_RAG_BENCHMARK_ENABLED=0 \
PYTHONPATH="$PWD/services/health-engine/src" \
  "$PYTHON" -m uvicorn huiyi_health_engine.app:app --host 127.0.0.1 --port 8324 --no-access-log
```

Point the A/B runner embedding URL at that service:

```bash
export HC_MEM_CONTRACT="$PWD/eval/memory/locomo/manifest-hc-mem-003-preflight.json"
export HC_MEM_ARTIFACT_DIR="$PWD/artifacts/hc-mem-003"
export HC_MEM_STATE_NAME=frozen-state
export HC_MEM_STATE_MANIFEST="$PWD/artifacts/hc-mem-002/frozen-state-manifest.json"
export LOCOMO_QA_MAX_TOKENS=256
export HUIYI_MEMORY_EMBEDDING_URL=http://127.0.0.1:8324/_internal/ama/embeddings
export AMA_EMBEDDING_URL="$HUIYI_MEMORY_EMBEDDING_URL"
```

Run the same first 12 questions plus `conv-30:qa-0001` through A, B and C, each to its own preflight output. The exact arm commands are:

```bash
$PYTHON eval/memory/locomo/run_upstream.py \
  --state-dir artifacts/hc-mem-003/preflight/arm-a-upstream/state \
  --output artifacts/hc-mem-003/preflight/arm-a-upstream/predictions.jsonl --limit 12
$PYTHON eval/memory/locomo/run_upstream.py \
  --state-dir artifacts/hc-mem-003/preflight/arm-a-upstream/state \
  --output artifacts/hc-mem-003/preflight/arm-a-upstream/predictions.jsonl --question-id conv-30:qa-0001
$PYTHON eval/memory/locomo/run_sidecar.py --memory-url http://127.0.0.1:8324 \
  --state-dir artifacts/hc-mem-003/preflight/arm-b-sidecar/state \
  --output artifacts/hc-mem-003/preflight/arm-b-sidecar/predictions.jsonl --limit 12
$PYTHON eval/memory/locomo/run_sidecar.py --memory-url http://127.0.0.1:8324 \
  --state-dir artifacts/hc-mem-003/preflight/arm-b-sidecar/state \
  --output artifacts/hc-mem-003/preflight/arm-b-sidecar/predictions.jsonl --question-id conv-30:qa-0001
```

Run C with its own read-only benchmark health-engine on port 8325, using the same profile and a distinct external ledger, with `HUIYI_MEMORY_DATA_DIR="$PWD/artifacts/hc-mem-003/preflight/arm-c-dsh/state"` and `HUIYI_MEMORY_LEDGER_PATH="$PWD/artifacts/hc-mem-003/preflight/dsh-ledger.sqlite"`. The embedding endpoint is derived from port 8325 by the service. Add `--memoryUrl http://127.0.0.1:8325` to the two C commands below.

```bash
PATH=/root/.nvm/versions/node/v22.23.3/bin:$PATH node --experimental-strip-types eval/memory/locomo/run_dsh.mjs \
  --memoryUrl http://127.0.0.1:8325 \
  --stateDir artifacts/hc-mem-003/preflight/arm-c-dsh/state --limit 12 \
  --trace artifacts/hc-mem-003/preflight/arm-c-dsh/trace-metadata.jsonl \
  --output artifacts/hc-mem-003/preflight/arm-c-dsh/predictions.jsonl
PATH=/root/.nvm/versions/node/v22.23.3/bin:$PATH node --experimental-strip-types eval/memory/locomo/run_dsh.mjs \
  --memoryUrl http://127.0.0.1:8325 \
  --stateDir artifacts/hc-mem-003/preflight/arm-c-dsh/state --questionId conv-30:qa-0001 \
  --trace artifacts/hc-mem-003/preflight/arm-c-dsh/trace-metadata.jsonl \
  --output artifacts/hc-mem-003/preflight/arm-c-dsh/predictions.jsonl
```

Then validate:

```bash
$PYTHON eval/memory/locomo/verify_preflight.py --old-artifact-root artifacts/hc-mem-002
```

The preflight passes only with 12 parseable ordinary answers per arm, the expected common-cap failure on the runaway C question, and exactly one C recall/model step with no tools or memory writes. Full construction is gated on this summary being `P0_CAP_VERIFIED`.

For full construction, first wait until the active RAG job releases the GPU and check GPU, cgroup RAM, disk, inodes, and port ownership again. Start one local health-engine process on port 8324 with `HUIYI_MEMORY_DATA_DIR` pointing to a separate embedding-service directory during construction; set `HUIYI_MEMORY_LEDGER_PATH` outside the AMA state, `HUIYI_LOCAL_EMBEDDING_MODEL=Qwen3-Embedding-0.6B`, `HUIYI_LOCAL_EMBEDDING_PATH=/root/gpufree-share/models/Qwen3-Embedding-0.6B`, `HUIYI_MEMORY_TURN_RETRIEVE=3`, `HUIYI_MEMORY_TOP_K=10`, `HUIYI_MEMORY_CAPTURE_USAGE=1`, `HUIYI_MEMORY_ISOLATE_RECALLS=1`, `HUIYI_RAG_ENABLED=0`, and `HUIYI_RAG_BENCHMARK_ENABLED=0`. The API process embeds on CPU and connects to the already running loopback vLLM endpoint for AMA model calls. Then run:

```bash
$PYTHON eval/memory/locomo/build_reference_store.py --state-name frozen-state-full
$PYTHON eval/memory/locomo/build_reference_store.py --state-name frozen-state-full --finalize
$PYTHON eval/memory/locomo/prepare_arm_states.py
```

The builder resumes only from complete sessions and checks the dataset SHA and exact selected scope before continuing. Finalization refuses a partial store or an existing frozen output. `prepare_arm_states.py` verifies the manifest and creates three byte-identical copies; each A/B/C runner checks all three copies before starting.

After the builder and state-copy preparation finish, stop only the benchmark health-engine process that HC-MEM-003 started for construction. Restart port 8324 with `HUIYI_MEMORY_DATA_DIR="$PWD/artifacts/hc-mem-003/arm-b-sidecar/state"`, its ledger outside that directory, and the parity profile (`TURN_RETRIEVE=3`, `TOP_K=10`, usage capture and recall isolation enabled). A uses this service only for the configured local embedding API; B uses the same process for the sidecar recall arm. The immutable `frozen-state-full/` source remains untouched.

After the P0 validation passes, run A then B using the same `max_tokens=256`, local model and frozen state. Configure the sidecar with `HUIYI_MEMORY_ISOLATE_RECALLS=1`, `HUIYI_MEMORY_TURN_RETRIEVE=3`, `HUIYI_MEMORY_TOP_K=10`, and `HUIYI_MEMORY_CAPTURE_USAGE=1`. Keep its idempotency ledger outside the state directory through `HUIYI_MEMORY_LEDGER_PATH`. Score both arms and run `compare.py --ab-only`; do not begin C if A/B retrieval or score parity fails. Run C only after A/B passes, using the same health-engine configuration with its data directory switched to `arm-c-dsh/state`, a different external ledger path, and the real `run_dsh.mjs` entry. Every runner appends results and skips completed question IDs on restart. C generates a new DSH session ID on each process invocation, so an interrupted unrecorded question cannot inherit prior DSH history.

Use the explicit full-store manifest for every full score/comparison command:

```bash
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-003/arm-a-upstream/predictions.jsonl \
  --frozen-manifest artifacts/hc-mem-003/frozen-state-full-manifest.json
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-003/arm-b-sidecar/predictions.jsonl \
  --frozen-manifest artifacts/hc-mem-003/frozen-state-full-manifest.json
$PYTHON eval/memory/locomo/compare.py --ab-only \
  --frozen-manifest artifacts/hc-mem-003/frozen-state-full-manifest.json
```

After C completes, score it and generate the final paired summary:

```bash
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-003/arm-c-dsh/predictions.jsonl \
  --frozen-manifest artifacts/hc-mem-003/frozen-state-full-manifest.json
$PYTHON eval/memory/locomo/compare.py \
  --frozen-manifest artifacts/hc-mem-003/frozen-state-full-manifest.json
$PYTHON eval/memory/locomo/bootstrap.py --paired artifacts/hc-mem-003/paired-diff.jsonl \
  --output artifacts/hc-mem-003/bootstrap-summary.json --replicates 10000 --seed 3003
$PYTHON eval/memory/locomo/finalize_hc_mem_003.py \
  --bootstrap artifacts/hc-mem-003/bootstrap-summary.json
```

After all three arms have exactly the same ordered 1,540 question IDs, run scoring, `compare.py`, and `bootstrap.py --replicates 10000 --seed 3003`. Keep the JSONL predictions, private raw prompts/answers, memory stores, and retrieval content ignored by Git. Only the sanitized `readiness.json`, benchmark manifest, aggregate metrics, bootstrap summary, and final report belong in the HC-MEM-003 commit. Report full parity separately from the external Token-F1/BLEU paper target; do not claim paper-level LLM Score without the exact GPT-4o-mini judge.
