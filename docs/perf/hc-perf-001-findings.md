# HC-PERF-001 Findings

## Executive result

On the authorized 68-question Dev slice, the fastest fully measured end-to-end candidate was BF16 Qwen3-8B on vLLM Eager with question concurrency 4, `max_num_seqs=8`, and `max_num_batched_tokens=2048`. It completed 68/68 cases in 470.1 s (8.68 questions/min), parsed 67/68 answers, had no failed root turns, and generated 61,249 known output tokens at 130.3 aggregate output tokens/s. Peak VRAM was 36,895 MiB. The historical 68-case artifact has no comparable full-batch makespan, so there is no defensible full-set speedup number.

On the same 24-case pilot, Eager concurrency 4 took 169.0 s versus 414.9 s at concurrency 1: 2.45x faster. Concurrency 8 was effectively flat/slightly slower at 171.7 s; concurrency 16 regressed to 195.7 s. CUDA Graph `FULL_AND_PIECEWISE` at concurrency 4 took 174.8 s, 3.5% slower than Eager C4. The graph run had 1.7% more measured output tokens/s, but also more model calls and output tokens, so this is not an isolated model-throughput win.

The main C4 bottleneck is model serving: during active turns SM utilization was near 100%, memory-controller utilization averaged roughly 90% with repeated 100% samples, while KV cache peaked at only 8.2% and VRAM stayed below 37 GiB. The GPU is not capacity-bound by its 48 GiB VRAM in this workload. Exact compute-versus-bandwidth attribution was not isolated with Nsight. At concurrency 16, a separate host/tool bottleneck appears: the 14-core cgroup approaches saturation and mean RAG latency rises from 0.29 s at C4 to 21.9 s, with 34.3 s P95. Thus more case concurrency no longer keeps the whole pipeline productive.

## Measured comparisons

| Configuration | Cases | Makespan | Speedup vs pilot C1 | Output tok/s | E2E P95 | Peak VRAM | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| Eager, concurrency 1 | 24 | 414.9 s | 1.00x | 56.4 | 24.9 s | 36,885 MiB | 0 runtime failures; 23 parsed |
| Eager, concurrency 2 | 24 | 253.9 s | 1.63x | 88.9 | 30.5 s | 36,885 MiB | 0 runtime failures; 24 parsed |
| Eager, concurrency 4 | 24 | 169.0 s | 2.45x | 134.4 | 40.0 s | 36,885 MiB | 0 runtime failures; 24 parsed |
| Eager, concurrency 8 | 24 | 171.7 s | 2.42x | 133.9 | 66.2 s | 36,885 MiB | 0 runtime failures; 24 parsed |
| Eager, concurrency 16 | 24 | 195.7 s | 2.12x | 114.8 | 140.0 s | 36,885 MiB | 0 runtime failures; 24 parsed |
| Eager C4, `max_num_seqs=16` | 24 | 177.1 s | 2.34x | 130.8 | 47.7 s | 36,971 MiB | Slower than C4 / default scheduler |
| Eager C4, batched tokens 4096 | 24 | 175.3 s | 2.37x | 131.6 | 47.1 s | 37,185 MiB | Slower than C4 / 2048 |
| Graph C4, FULL_AND_PIECEWISE | 24 | 174.8 s | 2.37x | 136.7* | 47.0 s | 35,937 MiB | 3.5% slower than Eager C4 |
| Eager C4, full authorized set | 68 | 470.1 s | Not comparable | 130.3 | 44.3 s | 36,895 MiB | 0 failed; 67 parsed; 38/68 Dev correct |

`*` Graph effective output tok/s includes different call/output totals (157 DSH requests and 23,898 known tokens versus Eager C4's 154 requests and 22,706 tokens). It is not a controlled decode-throughput comparison.

The historical partial run parsed 66/68 and scored 35/68 on the authorized Dev gold. The new full68 candidate parsed 67/68 and scored 38/68. Five answer choices differ from historical output, including one recovered parse. These small deterministic-settings runs still produce different answers under batching/concurrency; do not interpret the accuracy difference as an improvement or claim bitwise parity. No TEST labels were read.

For the full68 Eager C4 run, per-DSH model-call TTFT was 509 ms P50 / 834 ms P95 and TPOT was 25.69 ms P50 / 30.59 ms P95. These are individual DSH child/root model calls, not whole-question latency.

The separate synthetic vLLM API benchmark (64 non-clinical requests, 1,152-token nominal inputs, 112-token nominal outputs, 256-token shared prefix) measured:

| Requested concurrency | Makespan | Requests/s | Output tok/s | TTFT median / P99 | TPOT median / P99 |
|---:|---:|---:|---:|---:|---:|
| 1 | 171.6 s | 0.373 | 42.0 | 189 / 241 ms | 22.34 / 22.41 ms |
| 4 | 46.1 s | 1.387 | 156.3 | 75.7 / 104.9 ms | 24.78 / 24.87 ms |
| 8 | 24.9 s | 2.566 | 289.1 | 80.6 / 101.2 ms | 25.97 / 26.19 ms |

This API-only synthetic result shows higher model throughput at higher concurrency, but it excludes DSH, RAG, Memory, and per-case dependencies. The end-to-end result peaks at question concurrency 4 because tool/CPU contention offsets the server-side batching gain. Requested API concurrency is recorded; vLLM bench's observed request-overlap field exceeded the requested number in some trials, so that field is not treated as an exact active-sequence count.

## Optimization classes

- **A-class, method-preserving measurements:** question concurrency; Eager versus CUDA Graph; scheduler sequence/batched-token settings; prefix caching; same-model synthetic API throughput. Model revision, BF16, prompts, sampling, 768-token DSH request cap, collaboration, RAG, and Memory stayed fixed. Batch scheduling still changed five of 68 final choices versus historical output, so “method-preserving” does not mean bitwise-identical generation.
- **B-class semantic alternatives:** FP8, speculative decoding, alternative model or shortened output/method settings. These were not run. No quality or speed claim is made for them.

## Answers to the performance questions

1. **Bottleneck:** At C4, model inference saturates SM and memory-controller utilization; VRAM/KV capacity does not. At C16, host/RAG contention becomes dominant. The run does not isolate a single compute-versus-memory-bandwidth cause.
2. **Eager vs Graph:** Eager C4 is 3.5% faster by pilot makespan. Graph startup/capture is extra setup and excluded from timed makespan; it took roughly 45–55 s. Graph did not improve complete-question throughput.
3. **Question concurrency:** On the 24-case pilot: C1 414.9 s, C2 253.9 s, C4 169.0 s, C8 171.7 s, C16 195.7 s. C4 is best among tested. Full68 C4 was 470.1 s.
4. **Specialist overlap:** Yes. Metadata traces show up to three specialist model requests active simultaneously within a case; the specialist count/path was not reduced.
5. **Largest E2E gain:** Bounded question concurrency 1→4, 2.45x on the paired pilot. This is the scheduler/concurrency A-class change with the clearest full-pipeline gain.
6. **Model throughput without E2E gain:** API concurrency 8 raises synthetic server throughput to 289 tok/s, but the whole medical pipeline does not improve beyond case concurrency 4. CUDA Graph's higher effective pilot output tok/s did not improve makespan.
7. **Correctness:** Full68 had 0 runtime failures, 67/68 parsed, and five choice differences versus historical output. No new parser-failure increase was observed, but changed answers mean exact output parity and clinical safety are not established. Accuracy is Dev-only diagnostic.
8. **Fastest measured configuration:** vLLM Eager, BF16, `--max-model-len 40960 --gpu-memory-utilization 0.80 --max-num-seqs 8 --max-num-batched-tokens 2048 --enable-prefix-caching --enable-chunked-prefill --seed 0 --generation-config vllm --default-chat-template-kwargs '{"enable_thinking":false}' --enable-auto-tool-choice --tool-call-parser hermes --enforce-eager`; DSH root and child requests retain `maxTokens=768`; outer question concurrency 4. DSH request traces confirm all 416 full68 calls requested 768 tokens. The Memory client does not supply an explicit cap; the deployment-level `1024` cap previously recorded was not present in vLLM startup evidence and has been removed from the inventory.
9. **BF16 LoRA readiness:** Package imports and trainer signatures were checked, but no optimizer-step canary ran. After the owned vLLM process stopped, GPU availability could not be reconciled: a snapshot showed 36,895 MiB occupied with no process attribution and subsequent driver queries were intermittent. BF16 LoRA/QLoRA ability is therefore unverified.
10. **Next scaling step:** Do not buy more VRAM for this workload based on the observed low KV utilization. First validate a second model replica on a separately allocated GPU against the same 68 IDs and account for the 14-core/tool bottleneck. A different inference engine remains untested and has no evidence-based advantage here. Tensor parallelism is not justified for an 8B model that fits on one L40.

## Other confirmed measurements

- All 68 cases retained adaptive collaboration, RAG, and read-only Memory: 68 RAG calls / 204 hits; 68 Memory recalls, 136 Memory model calls, empty snapshots; 124 specialist runs and 42 moderators. No method branch was disabled.
- All 416 DSH calls requested 768 output tokens and none reached that cap; their finish reasons were `tool-calls` or `stop`. The Memory client does not send an explicit cap, so its serving default remains separately unspecified.
- C4 pilot Memory call latency averaged 3.10 s (P95 5.47 s); RAG averaged 294 ms (P95 1.26 s). At C16, RAG averaged 21.92 s (P95 34.26 s), while Memory latency remained near 3.37 s.
- C4 vLLM counters showed 79,952 prefix-cache hits / 282,377 queries, KV peak 8.2%, zero preemptions. These are server counters, not a guaranteed per-prompt token savings percentage.
- Inference process startup, model loading and CUDA Graph capture are excluded from E2E makespans. The API random benchmark is not clinical data.
- No FP8, speculative decoding, alternative-engine, offline `vllm bench latency`, or SFT canary run was performed. They remain not tested/blocked; no estimated numbers are reported.

## Artifacts and reproduction

The exact run IDs, candidate summaries, baseline hashes and environment checks are in `artifacts/hc-perf-001/`. Full request traces, GPU samples, synthetic benchmark JSON and raw candidate outputs remain outside Git at `/root/gpufree-data/repro/hc-perf-001/phase-b-20261009/`. The summary artifacts contain metadata only. The original historical output directory remains untouched.

The measured Eager server used the local serving venv and these material flags (other standard vLLM server defaults are omitted):

```bash
vllm serve /root/gpufree-share/data/Qwen3-8B \
  --host 127.0.0.1 --port 8000 --served-model-name Qwen/Qwen3-8B \
  --dtype bfloat16 --max-model-len 40960 --gpu-memory-utilization 0.80 \
  --max-num-seqs 8 --max-num-batched-tokens 2048 \
  --enable-prefix-caching --enable-chunked-prefill --seed 0 \
  --generation-config vllm \
  --default-chat-template-kwargs '{"enable_thinking":false}' \
  --enable-auto-tool-choice --tool-call-parser hermes --enforce-eager
```

The 68-case run used the existing DSH E2E runner with `--arm adaptive --calibration-set --concurrency 4`, the frozen 68-row Dev projection, and unique output/metadata trace paths under the external `eager-c4-full68` run directory. The 24-case pilot used the corresponding frozen 24-row projection. No worker mode other than the existing adaptive harness was enabled.

The Graph candidate used the same server/client settings, omitted `--enforce-eager`, and added `--compilation-config '{"mode":3,"cudagraph_mode":"FULL_AND_PIECEWISE"}' --cudagraph-metrics`. An earlier startup attempt without Hermes auto-tool configuration was stopped and excluded from results.

The synthetic API benchmark used the installed `vllm bench serve` command with `--backend openai-chat --dataset-name random --num-prompts 64 --num-warmups 4 --random-input-len 1152 --random-output-len 112 --random-prefix-len 256 --request-rate inf`, requested concurrency 1/4/8, temperature 0, seed 0, and thinking disabled. Its individual result JSON and synchronized metrics are in the external `api-synthetic` directory.
