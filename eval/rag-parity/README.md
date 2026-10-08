# HC-RAG-002 benchmark profile

This is an evaluation-only DSH composition for the MedQA parity experiment. It does not import or install Huiyi's normal product bundle, AMA Memory, Memory tools, the F0 fixture tool, or MDAgents. DSH headless owns each Session and AgentLoop. The `cot` method exposes no tools; `medrag` exposes one one-shot retrieval tool; `imedrag` exposes one native `research_medical_question` tool.

The benchmark-only health-engine routes are:

```text
POST /_internal/eval/rag/medrag
POST /_internal/eval/rag/imedrag
```

They return retrieval documents or i-MedRAG Q/A history, never a final answer. Both routes return 404 unless `HUIYI_RAG_BENCHMARK_ENABLED=1`, require `HUIYI_RAG_ENABLED=1`, and reject non-loopback peers. The normal product `/v1/rag/search` behavior remains separate.

## Local Qwen evaluation profile

This task uses the user's local Qwen3-8B checkpoint. It is a local-model A/B/C parity experiment, not a reproduction of the paper's Llama accuracy. The published 64.73/66.54/73.61 values remain reference context only; the primary gate is parity among upstream A, Huiyi direct B, and DSH C on identical cases and serving settings.

1. Copy [`deployment.example.env`](./deployment.example.env) to a local `deployment.env`, then review local paths. The committed file contains no credentials; the sample key is a placeholder because local vLLM is unauthenticated.
2. Start the configured vLLM server from the local deployment environment. The previous smoke used vLLM `0.30.1rc1.dev622+gf03026a54`, bfloat16, one L40, eager mode, and a 16,384-token total context. Verify GPU and cgroup capacity before starting it.
3. Create a dedicated DSH home/profile from pinned `headless`. Install only this evaluation package and apply [`profile-patch.example.yml`](./profile-patch.example.yml). Do not install the normal Huiyi product bundle, Memory, or the F0 fixture.
   Before invoking the DSH runner, load the ignored local `deployment.env` (or export `HC_RAG_LOCAL_API_KEY`); the pinned `pi-ai` route requires the configured `apiKeyEnv` even though local vLLM does not authenticate requests. The deployment file supplies only a local placeholder for this endpoint and must not be committed. Run with the matching pinned entry at `/root/gpufree-data/repro/hc-rag-002/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` and Node 22; do not rely on the global `dsh` version. The plugin requires DSH 0.2.1-alpha.1, and a mismatched global runtime can skip the evaluation bundle. Both setup failures from the first attempts are retained as invalid metadata records; only the pinned-runtime run is eligible as C evidence.
4. The same endpoint/model alias, temperature `0`, 1,024 output-token cap, and `enable_thinking=false` chat-template default are used for upstream, direct, and DSH arms. The local tokenizer template wraps JSON calls in `<tool_call>…</tool_call>`, so the server uses vLLM's `hermes` parser; `qwen3_xml` expects a different `<function=…><parameter=…>` body and returned empty DSH responses. The upstream step-by-step prompts remain unchanged and still request visible analysis; the no-thinking setting prevents Qwen3's separate hidden reasoning channel from consuming the entire output cap. Retrieved-document context is capped at 14,336 Qwen tokens so prompt overhead and output fit the 16,384 total model context.
5. Enable the existing shared health-engine with the full MedText manifest, MedCPT query encoder, tokenizer path, and internal benchmark flag. The internal routes remain disabled unless explicitly enabled and accept loopback requests only.
6. The original frozen validation selection contains 100 IDs. On 2026-10-08 the user reduced the active validation scope to 45; use the first 45 IDs from that already frozen selection, recorded in `artifacts/hc-rag-002/active-validation-ids-45.json` and `artifacts/hc-rag-002/active-eval-config-45.json`. The local projection is a first-45-row slice of the original question/options-only projection at `/root/gpufree-data/repro/hc-rag-002/datasets/validation-45.inference.jsonl`. It has exactly `id`, `question`, and `options`; inference runners reject extra gold/scoring fields. No labels were opened for this scope change.
7. Run upstream A, Huiyi direct B, and DSH C on the same 45-row projection/config. DSH headless starts one real Session/AgentLoop per case; `imedrag` requires exactly one native `research_medical_question` call and a completed turn. There are no retries within a valid frozen run.
8. Diagnose the 45-case paired results and meet the A→B / B→C gates before freezing code/config and opening TEST. Prediction files and execution manifests must be hashed before the separate scorer reads labels.

The benchmark service follows the pinned MedRAG flow: follow-up query generation → separate query-list parse call → per-query MedCPT retrieval → per-query follow-up answer → accumulated `Query:`/`Answer:` history. Later rounds condition on that history. Qwen generates the final choice inside the same DSH AgentLoop for C; Python returns research context only.

The initial Qwen parity configuration uses the pinned source/example values (`k=32`, `nRounds=4`, `nQueries=3`) as a declared bootstrap, not as the paper's recovered tuning. Any validation-based selection must be recorded before TEST. Never run TEST inference from a file containing gold labels.

## 45-case local Qwen validation result

On 2026-10-08, the user reduced the active validation scope to the first 45 IDs from the previously frozen 100-ID selection. All three arms ran on the same gold-free projection. Predictions and metadata traces were frozen and hashed before the validation scorer opened labels; MedQA TEST labels were not read.

| Arm | Correct | Accuracy | Parse/runtime failures |
| --- | ---: | ---: | ---: |
| A — pinned MedRAG upstream i-MedRAG | 35/45 | 77.78% | 0 |
| B — Huiyi health-engine direct | 37/45 | 82.22% | 1 parse failure |
| C — DSH AgentLoop | 31/45 | 68.89% | 7 (6 final-turn runtime failures, 1 research-tool failure) |

A→B passed the 2-point regression gate: B was 4.44 points higher. B→C failed: C was 13.33 points lower than B (paired bootstrap 95% interval for B−C: +2.22 to +24.44 points). Among the 38 C cases with parsed choices, B and C each had 31 correct and their choices matched in 36 cases. The seven C failures account for the full net accuracy gap: B was correct on six of those cases.

The C run made exactly one research-tool call on 44 cases. One case made three calls with two tool failures, then ended at `max-tokens`. Six other cases also ended with a final DSH `max-tokens` outcome; those final model steps emitted one token. The detailed cause of the final-generation limit is unresolved. Do not retry these cases or count the validation gate as passed.

The metadata-only aggregate is in [`validation-parity-45-metadata.json`](../../artifacts/hc-rag-002/validation-parity-45-metadata.json). Frozen predictions and per-case paired results remain under the external `repro/hc-rag-002/validation-45/` directory. Since B→C failed, stop before MedQA TEST and do not claim paper parity or HC-RAG-002 completion. The Qwen vLLM process was stopped after the run to release the GPU; the shared health-engine remains available.
