# HC-PERF-001: L40 inference performance audit

## Purpose and boundaries

This work measures and accelerates the existing Qwen3-8B BF16 HC-MA-002 end-to-end path on the L40. The measured method remains adaptive collaboration with its current RAG, read-only Memory and DSH behavior. No specialist, retrieval, memory, prompt, output, model or sampling rule is shortened to improve throughput. CUDA, scheduler and bounded question concurrency changes are measured separately from semantic changes such as FP8.

The chosen calibration set is the existing 68-case Dev partial run, IDs `medqa-dev-00000` through `medqa-dev-00067`. The source question projection has only `id`, `question` and `options`; its 68 case hashes match the frozen prediction metadata. A deterministic 24-case pilot is length-stratified within historical complexity for early tuning. Both input manifests and hashes are in `artifacts/hc-perf-001/baseline-manifest.json`; raw questions and run outputs stay outside Git.

Reserved TEST labels are not read. The prior 68-case run is preserved byte-for-byte. Candidate runs write to new external directories and compare IDs, parser completion, agent-call counts and output choices against the historical partial results.

## Measurement phases

1. Phase A records the host, cgroup, GPU, storage, CUDA, vLLM, model revision and serving configuration. It does not assume that idle utilization identifies the workload bottleneck.
2. Phase B adds metadata-only request instrumentation to the DSH stream boundary and captures the actual prompt/output token counters, first streamed token, finish reason, model-request duration, Memory/RAG timing, per-case time and whole-batch makespan. A vLLM Prometheus scraper and synchronized GPU telemetry accompany controlled runs.
3. Phase C uses the 24-case pilot for a bounded question-concurrency sweep (1, 2, 4, 8 and 16 where resources allow), then compares Eager with the installed vLLM CUDA Graph modes and tests promising scheduler settings. The 68-case set is used for paired confirmation of the selected candidate.
4. Phase D keeps FP8 and speculative decoding in separate semantic experiment arms and runs only when Phase C provides a reason to do so.
5. Phase F performs a small LoRA training environment canary only after inference benchmarks stop and the GPU is free. No SFT or RL training has started.

Question concurrency is independent from within-case specialist concurrency. Each case has its own DSH context and case-hash-derived read-only Memory identity. RAG and Memory behavior stay enabled. No cross-case session or Memory namespace is shared.

## Metric definitions

- Makespan is the wall interval from the first case admitted to the last case settled, excluding model and service startup; startup and graph-capture time are recorded separately.
- Per-case E2E starts before its RAG prefetch and ends after its DSH root turn and cleanup.
- Model-call duration and first streamed token are captured from the DSH `llm/stream` boundary. vLLM's own queue, TTFT, TPOT, prefill/decode, cache and scheduler histograms are reported only when exposed by this installed server.
- Effective output throughput is the sum of completed model-call output tokens divided by batch makespan. Missing provider token usage remains `NOT RECORDED`; it is never estimated as measured output.
- GPU VRAM, power, clocks, temperature and utilization are sampled during each run. CPU/cgroup, RAG, Memory and Agent wait intervals are aligned by UTC timestamps.
- Output parity is compared against the existing per-ID prediction and call metadata. A changed output is reported even when the request settings are nominally unchanged.

## Runtime safety

The local vLLM and health-engine processes run on loopback. Inference caches go to the model mount; logs and evaluation outputs go under `/root/gpufree-data/repro/hc-perf-001/`. Model weights, patient text, prompts, retrieved passages, raw model outputs, credentials and TEST gold are not committed. Every candidate is a new output directory. No shared process is stopped or replaced without checking its owner.
