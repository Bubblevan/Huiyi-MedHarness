# i-MedRAG upstream and reproduction map

## Scope and evidence

HC-RAG-001 integrates the already-run local reproduction. It does not rerun the paper evaluation and does not copy the MedRAG repository into this product bundle.

| Item | Audited value |
|---|---|
| Upstream | `Teddy-XiongGZ/MedRAG` |
| Upstream commit | `7599a728a28789fd601728c08d313b1148051f41` |
| Upstream entry point | `MedRAG.answer()` with `rag=True, follow_up=True`; `MedRAG.i_medrag_answer()` owns the research loop and final answer |
| Local wrapper | `/root/gpufree-data/repro/imedrag-small-20261007` |
| Local wrapper commit | None; the wrapper is a directory, not a Git checkout |
| Saved reproduction trace | `trace/session-metadata.json`, SHA-256 `14089bd7abd192bcd81c000376c9d8660a3195ab8a8440464d272c8fc6533e89` |
| Generator | Local `Qwen3-8B`, served as `gpt-3.5-turbo-16k` for the OpenAI-compatible client |
| Endpoint | `http://127.0.0.1:8000/v1`, OpenAI-compatible Chat Completions; vLLM `0.30.1rc1.dev622+gf03026a54` |
| Context window | 16,384 |
| Corpus profile | MedRAG `MedText` = Textbooks + StatPearls |
| Local corpus sample | 60 Textbooks chunks from `Anatomy_Gray.jsonl`; one StatPearls article (`article-20094`, 33 chunks); 93 chunks total |
| Retriever | MedCPT dense retrieval; Article Encoder revision `d05a736da4bb84ee4057b7f7999485be6ed85465`; Query Encoder revision `d83a36cc6b8e3a5c5e9d9d6ba156808c1643dcbc` |
| Reproduction parameters | `n_rounds=1`, `n_queries=2`, `k=3`, `max_tokens=1024` |
| Evaluation input | One fixed facial-nerve anatomy question based on the MedRAG README demonstration. No MedQA split was used; this was not an accuracy evaluation. |

The Textbooks and StatPearls dataset Git revisions were not preserved in the wrapper. The source chunk files and index components are therefore identified by the SHA-256 values in the local reproduction manifest produced for HC-RAG-001; no upstream dataset revision is inferred. The selected StatPearls article came from `statpearls_NBK430685/article-20094.nxml`.

The metadata trace reports the official no-RAG baseline as one model call, zero retrieval calls, and 20,632 ms. The i-MedRAG path returned non-empty output with six model calls, two successful retrieval calls, six aggregate retrieved hits, and 115,080 ms. The `k=0` probe was `UNSUPPORTED`: pinned MedRAG's FAISS path asserts on zero `k`; it is not evidence that empty results work. The trace status was `PASS_WITH_UNSUPPORTED_CASES`, with required smoke status `PASS`. It contains no question, model response, generated follow-up query, retrieved passage, or credential.

## Upstream ownership and product mapping

| MedRAG/i-MedRAG upstream | Huiyi HC-RAG-001 boundary |
|---|---|
| `src/medrag.py:MedRAG.answer()` | Audit/reference only. The product tool exposes a stable `MedicalEvidenceRequest` instead of upstream classes. |
| `src/medrag.py:MedRAG.i_medrag_answer()` follow-up loop | `services/health-engine/.../rag/iterative.py`: bounded evidence acquisition only. It returns an `EvidenceSet`; it never produces the user's final answer. |
| `src/medrag.py:MedRAG.medrag_answer()` retrieval branch | `rag/service.py` orchestrates the `Retriever` and evidence accumulator. |
| `src/utils.py:RetrievalSystem` / `Retriever` | A product wrapper under `rag/retriever.py`, loading only an explicitly prepared MedCPT index and returning normalized hit records. No runtime download or index build. |
| `src/utils.py:corpus_names` (`MedText`) and chunk/index files | Offline preparation inputs and a versioned manifest under `rag/corpus.py` / `scripts/rag/`. Corpus data stays outside Git. |
| `src/template.py` `follow_up_instruction_ask` | Product prompt/config under `rag/prompts.py`; output is validated JSON with bounded query count. This is a documented hardening adaptation. |
| Upstream query generation and query-specific answer observations | A local/self-hosted planner may generate search queries. Any internal LLM observation remains planner metadata and is never returned or labeled as retrieved evidence. |
| Upstream final answer generation in `i_medrag_answer()` | Not ported. The same DSH AgentLoop resumes after the tool result and owns the final response. |
| Upstream OpenAI client and generator dispatch | Not ported. Planner transport is a configured loopback/self-hosted HTTP endpoint; the outer generator remains DSH's configured provider. |
| Upstream corpus/index auto-download and build behavior | Not ported to runtime. `prepare_corpus.py`, `build_index.py`, and `verify_index.py` are explicit offline operations. |

## Deliberate adaptations

The product algorithm is **i-MedRAG-derived bounded iterative evidence acquisition**, not an unchanged i-MedRAG runtime. Huiyi preserves focused follow-up search and iterative evidence accumulation, while removing the upstream final-answer owner. Planner output is a validated structured object. Retrieval rounds, queries, candidates, returned snippets, and wall time are bounded and recorded. Only source-backed snippets receive citation evidence IDs; model-generated planning content does not.

The local reproduction's `n_rounds=1`, `n_queries=2`, and `k=3` describe its smoke configuration, not production defaults. HC-RAG-001 deployment limits are separately configured and must be reported in the live run metadata.
