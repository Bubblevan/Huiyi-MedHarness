# HC-RAG-002 paper and parameter audit

Audit date: 2026-10-07

Pinned sources:

- Huiyi task baseline: `e3b35a7dc53a48c66ae247124a34b876e7bc70ba`; the audited local HEAD is `ae90221b9ee3ad6c9aa146845e22811cb26d572b` with that baseline as its parent.
- DSH: `deepseek-ai/deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc`, version `0.2.1-alpha.1`.
- MedRAG: `gzxiong/MedRAG@7599a728a28789fd601728c08d313b1148051f41`.
- Paper: [arXiv:2408.00727v3](https://arxiv.org/abs/2408.00727).

## Method semantics recovered from pinned source

The pinned `src/medrag.py::i_medrag_answer()` follows the research Q/A-history method:

1. Format the original medical question and answer options.
2. Ask the model to analyze the question and generate `n_queries` focused follow-up queries.
3. Make a separate model call to parse those generated queries into a JSON list.
4. For each parsed query, call `medrag_answer(query, k=...)`. This retrieves documents for that query and asks the model to answer the query using the retrieved snippets.
5. Append `Query: ... / Answer: ...` to the accumulated context. Later query-generation prompts receive the original question/options and this Q/A history.
6. After the configured retrieval rounds, ask the model for its final answer to the original question using the accumulated Q/A history, then make a final format-conversion call for JSON output.

Retrieved source snippets and generated follow-up answers have different roles: only the snippets are source evidence; generated answers are internal research observations. The upstream product code returns the final answer as well, but the DSH benchmark adapter must stop at `ResearchHistory` and let the same DSH AgentLoop generate the user-facing choice.

With no parse failures and the upstream example defaults (`m=4`, `n=3`), the source path performs up to `2m + mn + 2 = 22` model calls per question: query generation and parsing per round, one answer call per follow-up query, then final analysis and format conversion. It performs up to `mn = 12` retrieval calls when the model generates exactly `n` queries per round. Parsing failures, empty query lists, or over-generation can change these counts; the benchmark trace must record actual calls and retrievals.

Other source details relevant to parity:

- Follow-up retrieval receives the generated query, not the original options.
- `medrag_answer()` renders retrieved snippets as numbered documents with title and content, then truncates that document context to `context_length`.
- The upstream follow-up prompt asks for `## Analysis` and `## Queries`; the answer prompt asks for `## Analysis` and `## Answer`.
- The implementation uses a regex plus `eval()` to parse the query-generation call and continues the bounded loop on parse errors. A safer parser is an integration adaptation and must preserve the accepted query list.
- The source loop allows `n_rounds + 3` iterations to handle finalization and parse failures. The benchmark must retain a hard bound and record adaptation details.

This is the part missing from HC-RAG-001's product retrieval policy. HC-RAG-001 remains the product feasibility milestone; its compact evidence-refinement loop is not evidence of paper-algorithm parity.

## Published results and discrepancy

Use the paper's Table 2 as the canonical target for Llama-3.1-8B on MedQA-USMLE:

| Method | Accuracy |
| --- | ---: |
| CoT | 64.73% |
| MedRAG | 66.54% |
| i-MedRAG | 73.61% |

The prose in the paper says 75.02% for Llama-3.1-8B i-MedRAG, while Table 2 says 73.61%. HC-RAG-002 uses 73.61%, as explicitly specified in the task. The paper states that i-MedRAG hyperparameters were tuned on 100 validation examples before test evaluation.

The paper describes Textbooks + StatPearls and MedCPT. The pinned MedRAG README reports historical corpus sizes of approximately 125.8k Textbooks snippets and 301.2k StatPearls snippets. These are reference counts, not measurements of the current local snapshot.

## Parameter recovery

The paper text names the varying parameters as iteration count `m` and query count `n`, and says they were tuned on 100 validation samples. It does not textually state the final MedQA Llama-3.1-8B values for `k`, `m`, `n`, output token limit, or exact inference server settings.

The pinned MedRAG source defaults and README example use:

| Parameter | Pinned source default/example | Status for paper table |
| --- | ---: | --- |
| `k` | 32 | Not confirmed as the final tuned paper value |
| `n_rounds` (`m`) | 4 | Not confirmed as the final tuned paper value |
| `n_queries` (`n`) | 3 | Not confirmed as the final tuned paper value |
| `rrf_k` | 100 | Not material to the single MedCPT retriever path |
| temperature | 0.0 for the OpenAI-compatible source route; `do_sample=False` for local Transformers | Greedy/zero-temperature behavior is supported by source, exact serving runtime remains unknown |
| retrieval context limit | 128,000 tokens for Llama-3.1 family in pinned source | Source implementation value; not proof of paper serving config |
| output limit | No explicit paper value recovered. The local Transformers path sets `max_length=131072`; the OpenAI-compatible path passes `max_tokens` only when the caller supplies it. | Unresolved |

Do not convert the README example into a claim about the paper's tuned parameters. The 100 validation IDs and their question/options fingerprints are frozen in `artifacts/hc-rag-002/frozen-validation-ids.json`; the selection is deterministic and excludes all gold fields. Before TEST is opened, use only this validation subset to select and freeze unresolved algorithm/output settings, and document the candidate grid and selection rule.

## Selected local evaluation model

Per the user's direction, HC-RAG-002 uses the already-present local Qwen3-8B checkpoint. The experiment is a local-model integration parity evaluation; it is not a Llama paper-number reproduction. The published Llama reference remains context only and is not the acceptance gate.

| Property | Frozen local artifact observation |
| --- | --- |
| Model ID sent to the endpoint | `Qwen3-8B` |
| Local directory | `/root/gpufree-share/data/Qwen3-8B` |
| Hugging Face revision | unavailable; this directory is not a Git checkout and no verified revision metadata was found |
| Architecture | `Qwen3ForCausalLM` (`model_type=qwen3`) |
| Model config maximum positions | 40,960 |
| Served context window for this parity run | 16,384 tokens, matching the previous successful local Qwen smoke deployment |
| Chat-template default | `enable_thinking=false`; all arms still receive the unchanged upstream step-by-step prompt |
| Output cap | 1,024 tokens per model call; a live DSH smoke showed Qwen's default hidden-thinking channel exhausted this cap, while a direct request-level `enable_thinking=false` check completed in 285 output tokens |
| Runtime observed in the previous smoke log | vLLM `0.30.1rc1.dev622+gf03026a54`, bfloat16, one L40, eager mode |
| `config.json` SHA-256 | `f7c4eadfbbf522470667b797a3c89be2524832d2d599797248dc304fff447c30` |
| `tokenizer_config.json` SHA-256 | `d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101` |
| `model.safetensors.index.json` SHA-256 | `f9fdbcb91c23971c13ec5d5f2573d2349e8f61f2f049371ec699281748fdb1bc` |

All three arms must use this same local checkpoint, served alias, loopback OpenAI-compatible Chat Completions endpoint, temperature `0`, output cap, and chat-template default. vLLM documents `--default-chat-template-kwargs '{"enable_thinking": false}'` for Qwen3; the original i-MedRAG prompts remain unchanged and still ask for visible step-by-step analysis. The local tokenizer emits JSON inside `<tool_call>` tags, so the serving command uses vLLM's Hermes parser. The Qwen3 XML parser expects `<function=…><parameter=…>` bodies and caused DSH empty responses. This is an endpoint-format compatibility setting; DSH still owns native tool scheduling. These settings are local deployment facts, not paper settings.

## Dataset and scoring contract

The official MIRAGE benchmark repository at commit `392943af99cd94cafd50a0de2e7fca24bbf65494` contains 1,273 `medqa` records. Its ordered question/options fingerprint matches the test split in the pinned MedQA mirror revision `awinml/medqa@afdb980b627374a7f10a0a11ed68455596c52742`. The hashes, counts, key-order digest, and cross-check are in `benchmark-contract.json`.

The pinned MIRAGE scorer expects answer labels `A`–`D` and maps them to option indices. Its legacy parser defaults unrecognized output to `A`; HC-RAG-002 must not inherit that fallback. Freeze a deterministic parser before TEST; an unresolved parse counts as incorrect and is reported as a parse failure. The inference projection must contain only question and options. Gold remains on the scorer side until prediction and execution manifests have been hashed.

## DSH integration constraint

At the pinned DSH revision, `GenerateOptions` accepts tool schemas but has no native `tool_choice` field, and the pi-ai adapter documents `tool_choice` as unmapped. Do not patch DSH. The eval-only system instruction will request one research tool call; zero calls and more than one outer research call are recorded as sample failures. The normal Huiyi `apply()` path and product RAG policy stay intact; the evaluation composition must exclude Memory, its tools, and the F0 fixture.

## Previous local reproduction scope

`/root/gpufree-data/repro/imedrag-small-20261007` called the official pinned `MedRAG.answer()` entrypoint with `rag=True, follow_up=True` on a deliberately small fixture (60 Textbooks chunks and 33 chunks from one StatPearls article) using Qwen3-8B. It did not use MedQA and did not report benchmark accuracy. It is an integration smoke, not a full i-MedRAG paper reproduction. HC-RAG-002 will not rerun it as a substitute for the A/B/C MedQA experiment.

## HC-RAG-002 acceptance scope

The canonical paper table reports 64.73% CoT, 66.54% MedRAG, and 73.61% i-MedRAG for its Llama-3.1-8B setup; the paper prose also has a 75.02% discrepancy. Neither paper number is a Qwen acceptance threshold. HC-RAG-002's primary claim is limited to whether DSH insertion preserves the pinned upstream i-MedRAG result under this local Qwen, full MedText, MedCPT, and shared vLLM stack. Report absolute Qwen accuracy as an experimental result without calling it the paper reproduction.
