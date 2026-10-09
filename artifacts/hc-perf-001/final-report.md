# HC-PERF-001 Final Report

Branch: `codex/hc-perf-001-l40`. Base commit: `b6aea7bb4d836e35349739da5ece97a64b9ec17b`.

## Outcome

The fastest verified complete workload configuration is Qwen3-8B BF16 on vLLM Eager, `max_model_len=40960`, `gpu_memory_utilization=0.80`, `max_num_seqs=8`, `max_num_batched_tokens=2048`, prefix caching and chunked prefill enabled, thinking disabled, Hermes tool parser enabled, and outer question concurrency 4. Existing DSH `maxTokens=768`, collaboration, RAG, Memory, and within-case specialist parallelism were preserved.

The paired 24-case pilot improved makespan from 414.9 s at concurrency 1 to 169.0 s at concurrency 4 (2.45x). Concurrency 8 did not improve makespan; concurrency 16 regressed. CUDA Graph `FULL_AND_PIECEWISE` was 3.5% slower than Eager C4. The full authorized 68-case run completed in 470.1 s, or 8.68 questions/min, with 130.3 known output tokens/s, 44.3 s E2E P95, 36,895 MiB peak VRAM, zero failed cases, and 67/68 parsed answers.

The historical 68-case result has no comparable full-batch makespan, so a full-set speedup cannot be computed. Current output choices differ in 5/68 cases from historical results. Dev accuracy was 38/68 versus historical 35/68; this is not treated as a quality improvement. No TEST gold was read.

## Bottleneck and next step

During active turns the L40 ran near 100% SM utilization with high memory-controller activity. KV cache peaked near 8.2%, so current VRAM/KV capacity is not the limiting factor. At case concurrency 16, CPU/RAG contention becomes visible: mean RAG latency increased to 21.9 s (P95 34.3 s) under the 14-core cgroup. Test a second model replica only on a separately allocated GPU and only after accounting for the tool/CPU ceiling. An inference-engine change has not been tested.

Synthetic API throughput rose with request concurrency, reaching 289.1 output tok/s at requested concurrency 8, but this synthetic result omits DSH/RAG/Memory and does not improve E2E makespan beyond case concurrency 4.

## Training preflight

Package imports and TRL signatures passed, but BF16 LoRA/QLoRA canaries did not run. After the owned vLLM process stopped, GPU availability could not be verified because memory remained occupied without process attribution and NVML queries became intermittent. No optimizer step, adapter, or checkpoint was created. SFT readiness remains unverified; pinned veRL/Ray/tensordict/OmegaConf are also absent for RL.

## Verification boundary

This run uses the exact 68 authorized Dev IDs and fixed 24-case pilot. RAG remained enabled for all cases (68 calls, 204 hits); read-only Memory remained enabled (68 recalls). No GPU task is running now from this branch. Original historical results and TEST boundaries were preserved.

Detailed results and run command forms: `docs/perf/hc-perf-001-findings.md`. Environment checks: `environment-inventory.md` and `environment.json`. Numeric candidate, output parity and telemetry summaries: `candidate-matrix.csv`, `e2e-comparison.json`, `output-parity-report.json`, `api-throughput-summary.json`, and `gpu-telemetry-summary.json`. The synthetic training canary status is in `training-canary-summary.json`.
