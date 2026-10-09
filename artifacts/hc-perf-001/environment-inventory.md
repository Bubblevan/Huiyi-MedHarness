# HC-PERF-001 Environment Inventory

Inventory combines live commands, vLLM startup logs, GPU samples, and the metadata-only E2E traces collected on 2026-10-09. Runtime paths and full telemetry remain outside Git under `/root/gpufree-data/repro/hc-perf-001/phase-a-20261009/` and `phase-b-20261009/`.

## Host and GPU

- **GPU-01 — PASS.** NVIDIA L40, 46,068 MiB, compute capability 8.9, 300 W limit, Driver 580.126.09 / CUDA driver 13.0. MIG is N/A; `nvidia-smi` reported no virtualization mode. PCIe Gen4, GPU NUMA node 1, CPU affinity `32-63,96-127`.
- **GPU-02 — PASS with power note.** During C4 E2E samples, the GPU reached 71 °C and sustained SM clocks up to 2,490 MHz / memory clock 9,001 MHz. Hardware thermal slowdown and hardware power brake were inactive. Software power capping was active at times under the 300 W limit; this is recorded and not hidden.
- **GPU-03 — PASS, attribution bounded.** Active-turn GPU utilization was near 100%, with memory-controller utilization averaging roughly 90% and repeated 100% samples. This indicates the inference device is heavily utilized, but no Nsight trace was run to isolate compute saturation from bandwidth saturation. Peak allocated VRAM was 36,895 MiB and KV usage peaked near 8.2%, with zero preemptions; KV/VRAM capacity was not the limiter.
- The container is limited to 14 CPU-equivalents and 120 GiB RAM despite 128 logical host CPUs. During full68 the maximum sampled cgroup memory was about 32.6 GB and OOM counters remained zero. Host swap was absent.
- Current filesystems: `/root/gpufree-data` has about 5.7 GiB free; `/root/gpufree-share` about 132 GiB and roughly 2,574 free inodes. Large model/cache data remained on the model mount.
- **Current ownership caveat:** the task-owned vLLM PID was stopped after benchmarks. A later GPU snapshot showed 36,895 MiB occupied at 0% utilization with no process attribution; following `nvidia-smi` calls intermittently failed to communicate with the driver. No further GPU operation was started. This affects training canary readiness, not the earlier recorded workload telemetry.

## Software and model

- **ENV-01 — PASS.** Serving Python 3.11.17, PyTorch 2.13.0+cu130, CUDA runtime 13.0, vLLM `0.30.1rc1.dev622+gf03026a54`, Triton 3.7.1, Transformers 5.17.0. Node v22.23.3, required pnpm 11.7.0.
- **ENV-02 — PASS.** Qwen3-8B loaded in BF16 for the Eager and Graph runs. Model revision `b968826d9c46dd6066d109eabc6255188de91218`; local checkpoint manifest and config hashes are recorded in `environment.json`.
- **ENV-03 — PASS.** vLLM V1 selected its bundled `FLASH_ATTN` attention backend. Python `flash-attn` and FlashInfer packages were absent; the installed vLLM startup logged FlashInfer cubin/toolchain prerequisites unavailable.
- **ENV-04 — PASS for DSH requests.** Context window is 40,960. All 416 DSH requests in full68 carried `max_tokens=768`; no server-wide 1,024-token output cap appeared in startup evidence. The Memory client sends no explicit output cap, so its effective default is owned by the installed vLLM request path and is not attributed a guessed fixed value here. No request cap was reduced for this benchmark.
- Previous serving settings retained BF16, `max_model_len=40960`, GPU memory utilization 0.80, `max_num_seqs=8`, automatic KV dtype, prefix caching, chunked prefill, seed 0, thinking disabled, Hermes tool parsing. Eager used `--enforce-eager`; Graph used compilation mode 3 with `FULL_AND_PIECEWISE` and did not enable `--enforce-eager`.
- The historical 1,024 server-output-cap note was removed after checking current startup logs and DSH request traces. Root and child DSH calls retained their configured 768-token cap.

## Runtime, scheduler and tools

- **INF-01 — BLOCKED.** E2E DSH TTFT/TPOT and synthetic API TTFT/TPOT were measured. Offline prefill/decode `vllm bench latency` microbenchmark was not run because GPU availability could not be reconciled after serving shutdown.
- **INF-02 — PASS.** Eager C4 versus true `FULL_AND_PIECEWISE` C4 ran on the same 24 Dev IDs; Graph was 3.5% slower by makespan. Graph capture/startup time (~45–55 s) was excluded from timed E2E.
- **INF-03 — PASS.** E2E case concurrency 1/2/4/8/16 was measured; C4 `max_num_seqs=16` and `max_num_batched_tokens=4096` were also measured and slower than defaults. No pressure evidence justified 32/64 sequences or larger batch-token sweeps. The selected setting is `max_num_seqs=8`, `max_num_batched_tokens=2048`.
- **INF-04 — PASS.** Prefix caching was enabled and vLLM reported 79,952 cache hits / 282,377 queries for Eager C4 pilot. These counters do not guarantee equivalent token savings. KV peak 8.2%, preemptions 0.
- **INF-05 — BLOCKED / NOT TESTED.** FP8 is a separate semantic experiment arm; it was not run and no output-quality comparison exists.
- **INF-06 — BLOCKED / NOT TESTED.** No verified Qwen3-compatible draft checkpoint was available; speculative decoding was not tested.
- **AGENT-01 — PASS.** Bounded case-worker concurrency was exercised through 16 on pilot and 4 on full68, with stable ID order and separate case namespaces.
- **AGENT-02 — PASS.** Metadata shows up to three specialist model requests overlapping within one case; no specialist path was removed.
- **AGENT-03 — PASS with limitation.** DSH stream request traces, vLLM scheduler metrics, and RAG/Memory durations were captured. At C16, CPU contention coincided with RAG latency inflation. No DSH service/process startup was added to the candidate path.
- **AGENT-04 — PASS.** Full68 retained all 68 RAG calls / 204 retrieval hits and 68 read-only Memory recalls. Memory had 136 traced model calls; snapshots were empty. C4 pilot RAG mean/P95 294 ms / 1.26 s; Memory call mean/P95 3.10 / 5.47 s. At C16 RAG mean/P95 rose to 21.92 / 34.26 s.
- **AGENT-05 — PASS.** Each case received a distinct DSH session and case-hash-derived Memory identity; no cross-case reuse was introduced.

## Evaluation and training

- **EVAL-01 — PASS.** Exact 68 Dev IDs and input hash recorded; every candidate used the same 24-case pilot hash. No reserved TEST gold was read.
- **EVAL-02 — PASS with output differences recorded.** Full68 had zero failed root turns and 67/68 parsed answers versus historical 66/68. Five choices differ from historical output, one of which is a parse recovery. No bitwise-equivalence or clinical-safety claim is made.
- **EVAL-03 — PASS.** Full authorized set makespan is 470,063 ms. The historical partial artifact lacks a comparable full-batch makespan, so speedup versus history is not computed.
- **EVAL-04 — PASS.** GPU telemetry and actual vLLM metrics were collected on E2E and synthetic API runs. Metrics emitted by this version included running/waiting requests, KV usage, token counters, prefix cache counters and request TTFT/TPOT/prefill/decode/queue histograms.
- **SFT-01 — PASS for package inventory/imports only.** Transformers, TRL, PEFT, Unsloth, Accelerate, bitsandbytes, datasets and safetensors are installed and import/signature checks passed. This is not a model-training compatibility pass.
- **SFT-02 / SFT-03 / SFT-04 — BLOCKED.** No BF16 LoRA or QLoRA training step, save/reload, or checkpoint test ran because free GPU ownership could not be verified after vLLM stopped.
- **SFT-05 — PASS.** Serving and health-engine use separate Python environments.
- **RL-01 — BLOCKED.** Pinned veRL, Ray, tensordict and OmegaConf are missing from the inspected environment; a compatible RL stack was not established.

See `environment.json`, `api-throughput-summary.json`, `e2e-comparison.json` and `candidate-matrix.csv` for scalar values and status details. Raw traces, Prometheus samples and benchmark output remain outside Git.
