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
- The DSH composition mounts only core Session, Agent, AgentLoop, local Qwen, and automatic Huiyi Memory. It does not install the evidence capability or manual memory tools.
- `A_UPSTREAM` and `B_SIDECAR` use the pinned official `QANemoriPrompt`. `C_DSH` uses the evaluation-only prompt adaptation in `prompt.ts`; product prompts are unchanged.
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

The active local loopback endpoint on port 8000 already serves the pinned Qwen3-8B snapshot through vLLM. HC-MEM-002 reuses that process and does not start or change an inference server. The frozen manifest records the observed vLLM build, served model name, 16,384-token context, BF16 dtype, and generation settings. Before each arm, the runner checks `/v1/models` for the exact served name and context length. Use one identical endpoint for A, B, and C. If it is unavailable, first re-check GPU/cgroup resources and serving-process ownership before starting anything.

The canonical model identity is `Qwen/Qwen3-8B`; its server alias is `Qwen3-8B`. This distinction matters because the local vLLM process accepts only the configured served alias. AMA internal calls, standalone A/B answers, and the DSH adapter all send that same alias. The embedding endpoint remains the existing loopback health-engine. Do not use a hosted model route. Every evaluation runner verifies the dataset hash, model identity, served model/context, loopback URLs, and frozen-state hashes before evaluating.

Before model startup, re-check the current GPU, cgroup memory, disk space/inodes, and listening ports. Use separate health-engine processes and data directories for construction, B, and C. Do not stop the accepted product health-engine process on port 8322. Example benchmark sidecar profiles:

```bash
HUIYI_HEALTH_ENGINE_HOST=127.0.0.1 \
HUIYI_HEALTH_ENGINE_PORT=8324 \
HUIYI_HEALTH_ENGINE_URL=http://127.0.0.1:8324 \
HUIYI_MEMORY_DATA_DIR=/root/gpufree-data/Huiyi-MedHarness/artifacts/hc-mem-002/arm-b-sidecar/state \
HUIYI_MEMORY_TURN_RETRIEVE=3 HUIYI_MEMORY_TOP_K=10 HUIYI_MEMORY_CAPTURE_USAGE=1 \
PYTHONPATH=/root/gpufree-data/Huiyi-MedHarness/services/health-engine/src \
  $PYTHON -m huiyi_health_engine.app
```

For Arm C use port `8325` and `arm-c-dsh/state`. Use the existing AMA Python environment for the health-engine process so this run does not install dependencies into either project.

## Build and freeze the common store

The construction script checkpoints only complete LoCoMo sessions. It redirects upstream AMA output so dialogue content does not reach terminal logs. A resumed build checks the dataset hash and discards an incomplete session copy rather than replaying a partially written session into the durable store.

```bash
export PYTHONPATH="$PWD/eval/memory/locomo:$PWD/services/health-engine/src"
$PYTHON eval/memory/locomo/build_reference_store.py
$PYTHON eval/memory/locomo/build_reference_store.py --finalize
```

Copy `frozen-state/` byte-for-byte into:

```text
artifacts/hc-mem-002/arm-a-upstream/state/
artifacts/hc-mem-002/arm-b-sidecar/state/
artifacts/hc-mem-002/arm-c-dsh/state/
```

Copy `frozen-state/` into each `state/` directory with `cp -a frozen-state/. <arm>/state/`. Each runner checks all files against `frozen-state-manifest.json` before its first recall. The A/B comparison command below stops before Arm C unless all 1,540 questions were evaluated and both Token-F1 and BLEU-1 deltas are within 0.01 absolute.

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
PATH=/root/gpufree-data/.toolchain/node-v22.19.0/unpacked/bin:$PATH \
  node --experimental-strip-types eval/memory/locomo/run_dsh.mjs \
    --memory-url http://127.0.0.1:8325
$PYTHON eval/memory/locomo/score.py artifacts/hc-mem-002/arm-c-dsh/predictions.jsonl
$PYTHON eval/memory/locomo/compare.py
```

Each runner appends completed questions and skips them on restart. `--limit N` is only for a labeled debug prefix and must never be passed to the full evaluation. A/B/C must have identical ordered question IDs before scoring/comparison.

## Metrics and cost

`score.py` mirrors the pinned AMA evaluator's Token-F1 tokenizer and smoothed BLEU-1 definition. Exact prompt/completion counts are taken from the local OpenAI-compatible responses. The health-engine benchmark profile forces AMA `showUsage` on internally while capturing token counters; no memory text is added to generic traces. `run_dsh.mjs` records prompt/completion counts, model-step count, one-recall count, and metadata-only turn timing. The UTF-8 memory token estimate is retained only as a clearly labeled diagnostic and is not compared with model token usage.

Run warm steady-state comparisons with the same local model process. Cold process startup time must be recorded separately if a cold service run is measured. The recovered reference did not include comparable latency or complete token accounting.

## Interpretation

Gate A→B isolates health-engine adapter normalization/configuration. Gate B→C isolates DSH lifecycle and prompt projection. The principal parity tolerances are absolute 0.01 for overall Token-F1 and BLEU-1. Report category-level changes for all four included categories. If an A→B gate fails, inspect `paired-diff.jsonl` and fix only demonstrated adapter/configuration losses before starting C.

Do not call the one-question local smoke a benchmark. Do not claim the local result is numerically equal to the paper's GPT-4o-mini judge score.
