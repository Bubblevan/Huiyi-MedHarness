# H2 Phase B/C Pilot and Quality-Judge Status

As of 2026-10-15. The full 12-question pilot is still not a validated quality result. A one-question model-judge smoke score is now recorded separately below.

## Frozen inputs

- Dataset: h2-pilot-dev-draft-v1, 12 draft DEV questions across six categories. Frozen query SHA-256: c9ef7211048cb8b3d1af02f47fb58822b1383930dff79cea1a8e63fed8543091.
- Corpus: five-source Qwen3-Embedding-0.6B, medtext-local-cc7d43568501e6b7. Manifest SHA-256: ccc89d1f6deef68536647541fbad6c79c98f7185cfbe2cd0c00698b15f5b37cf.
- Query/article encoder revision: 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3. The active FAISS indexes were not rebuilt or modified.
- BM25: SQLite FTS5 over the same 823,450 prepared chunks, title/body weight 3:1, Latin casefolded words plus overlapping CJK bigrams. Derived database SHA-256: 181a26d6a37de335e27998cca5a5ad64d2d6b76044fa031f606973de11a93a61 (544,268,288 bytes).
- RRF constant: 60. Candidate budget: 20 per arm. bge-reranker-v2-m3 reranks only RRF Top-20 and adds no candidates; weights SHA-256: d9e3e081faff1eefb84019509b2f5558fd74c1a05a2c7db22f74174fcedb5286.
- No patient Encounter or Memory data was sent to retrieval. A–D used no planner. E used the local Codex app-server bridge with GPT-6-Luna only to generate retrieval queries; it did not generate a user answer.
- Source revision: repository HEAD 28ba197ed3499272efdfaeda20645be7300ec796. The RAG runtime paths were clean against that commit when checked; unrelated worktree changes existed. Each arm’s runner SHA-256 is frozen in the v2 integrity record.

## Observed execution

| Arm | Successful queries | Results/query | P50 | Nearest-rank P95 | Planner calls | Reported input/output tokens |
|---|---:|---:|---:|---:|---:|---:|
| A · Dense | 12/12 | 20 | 275.0 ms | 672.4 ms | 0 | 0 / 0 |
| B · BM25 | 12/12 | 20 | 3.2 ms | 3,869.7 ms | 0 | 0 / 0 |
| C · Dense + BM25 / RRF | 12/12 | 20 | 277.4 ms | 4,194.4 ms | 0 | 0 / 0 |
| D · RRF + BGE reranker | 12/12 | 20 | reranker stage: 114.0 ms; warm RRF + reranker component sum: 396.6 ms | reranker stage: 255.3 ms; warm RRF + reranker component sum: 4,285.9 ms | 0 | 0 / 0 |
| E* · Dense + iterative GPT-6-Luna planner cost probe | 12/12 | 20 final candidates | 9,408.7 ms | 12,350.2 ms | 24 | 415,247 / 975 |

A–D timings are one-pass DEV observations, not stable service-latency benchmarks. RRF latency is Dense plus BM25 per-query latency plus negligible fusion work. **D has two timing views:** the stored `run-rrf-reranker.json` `latencyMs` values (P50 114.0 / P95 255.3 ms) measure only `_rerank()`; they omit the RRF retrieval stage. The warm full-path estimate above joins each question's RRF and reranker-stage times and sums them (P50 396.6 / nearest-rank P95 4,285.9 ms). This is a component-summed estimate from sequential stage measurements, not a newly timed end-to-end D request. The D tail is dominated by bilingual H2-P-007 and H2-P-008; nearest-rank P95 is H2-P-007. Reranker model load plus all 12 reranks took 4,881.7 ms at run level; A–D pool generation took 12.654 seconds for Dense+BM25.

The D timing recomputation, per-query component sums and source run hashes are in the Git-ignored `h2-pilot-v2/d-stage-latency-audit.json`; it does not change either frozen run file.

## First retrieval-quality smoke score

The new H2-RAG-QUALITY request supersedes the old Excel-first review gate. An automatic judge runner and a pooled-qrels scorer now exist in `eval/rag-retrieval/judge_pool.py` and `score_judge_runs.py`. The configured GPT-6-Luna loopback was probed with one six-candidate batch and returned HTTP 401; no user-level planner key is configured in this shell. The runner correctly kept all 38 query-1 candidates unresolved and did not turn the failure into zero-relevance labels.

To make a real, narrowly scoped quality trial rather than stop at the API error, the current Codex conversational model judged the blinded 38-candidate pool for H2-P-001. This is a **single-query model fallback**, exact serving model ID unavailable, not an API batch run, expert review, or external-Gold comparison. It assigned 0/1/2 grades, retained exact snippet quotes for nonzero grades, and flagged two low-confidence labels; its resolved-label coverage is 36/38 (94.7%). The exploratory calculation explicitly included those two flagged labels and must not be treated as final qrels.

| Arm | n | nDCG@10 | MRR@10, direct grade 2 | Precision@5, direct grade 2 | Pooled Recall@5, direct grade 2 |
|---|---:|---:|---:|---:|---:|
| A · Dense | 1 | 0.7729 | 0.5000 | 0.40 | 0.6667 |
| B · BM25 | 1 | 0.3841 | 0.2500 | 0.20 | 0.3333 |
| C · RRF | 1 | 0.8002 | 1.0000 | 0.40 | 0.6667 |
| D · RRF + BGE reranker | 1 | 0.8864 | 1.0000 | 0.40 | 0.6667 |
| E* · Dense + iterative | 1 | 0.9521 | 1.0000 | 0.40 | 0.6667 |

These values describe only H2-P-001 and one model's provisional labels. They do **not** establish that C/D/E improve retrieval: there is no multi-question uncertainty estimate, qrels are not independently validated, and pooled recall is not full-corpus recall. The main smoke result is diagnostic: BM25's first five contain one direct-support passage versus two for each other arm, while E* places its judged relevant material higher in the full ranking; this must be retested on the frozen 100-DEV/200-HOLDOUT design before drawing a conclusion. The machine-readable judgment and score are `eval/rag-retrieval/results/h2-pilot-v2-conversation-judge-smoke.json` and `h2-pilot-v2-q001-conversation-judge-score.json`.

## Source-anchor retrieval-quality smoke

To add a deterministic quality signal while the judge API is unavailable, three diagnostic questions were authored against exact chunks already in the frozen corpus and run through A–D on the same 20-candidate budget. The exact source chunk was rank 1 for all three questions in all four arms:

| Arm | n | Anchor Hit@1 | Hit@5 | Hit@10 | Hit@20 | Anchor MRR |
|---|---:|---:|---:|---:|---:|---:|
| A · Dense | 3 | 100% | 100% | 100% | 100% | 1.000 |
| B · BM25 | 3 | 100% | 100% | 100% | 100% | 1.000 |
| C · RRF | 3 | 100% | 100% | 100% | 100% | 1.000 |
| D · RRF + BGE reranker | 3 | 100% | 100% | 100% | 100% | 1.000 |

This confirms that each retriever can recover a known, exact supporting chunk for these three selected queries. It does **not** show equivalence or superiority: the pilot is tiny, the query authors chose the anchors, and all methods hit the rank-1 ceiling. These are author-selected source anchors, not independent or expert-graded qrels. The machine-readable result with dataset, corpus-manifest and run hashes is `eval/rag-retrieval/results/h2-source-anchor-seed-20261015.json`; query definitions are `eval/rag-retrieval/source-grounded-3-dev.json`.

## GPT-6-Luna blinded relevance-judge smoke

The OpenAI-compatible loopback endpoint at `127.0.0.1:8333` still returns HTTP 401 with the configured placeholder credential. A separate, read-only `codex exec --model gpt-6-luna` path did work, so one blinded question was scored end to end: H2-SG-001, 33 pooled candidates, grades 0/1/2 = 3/27/3, and 0 labels below the 0.65 confidence threshold. Candidate coverage was exact and every nonzero exact quote passed substring validation. These remain single-model, single-question machine judgments, without expert adjudication or external-Gold agreement.

| Arm | n | nDCG@10 | direct-support Precision@5 | pooled direct-support Recall@5 |
|---|---:|---:|---:|---:|
| A · Dense | 1 | 0.8864 | 0.40 | 0.6667 |
| B · BM25 | 1 | 0.8506 | 0.40 | 0.6667 |
| C · RRF | 1 | 0.8864 | 0.40 | 0.6667 |
| D · RRF + BGE reranker | 1 | 0.8567 | 0.40 | 0.6667 |

For this one query, all arms put the first direct-support chunk at rank 1, and all found two of the three judged direct-support chunks in their first five. The small nDCG@10 differences are not evidence of a winner; a paired interval is undefined at n=1. Pooled recall is over the 33 judged candidates, not all 823,450 corpus chunks. The run consumed 76,605 input tokens and 11,444 output tokens (8,366 reasoning tokens) in the Codex CLI turn; this is too costly to extrapolate blindly to a 300-question, full pooled-judgment run. The normalized qrels, score, exact prompt and raw response are saved in `eval/rag-retrieval/results/h2-source-seed-q1-codex-cli-judge-smoke.json`, `h2-source-seed-q1-codex-cli-judge-score.json`, `h2-source-seed-q1-codex-cli-judge-smoke.prompt.md` and `h2-source-seed-q1-codex-cli-judge-smoke.raw.json`.

E* ran two rounds and two retrieval calls per question, with no degraded or failed rows. With 20 candidates requested on each call, it exposed at most 40 raw result slots per question, then deduplicated/ranked and returned a final Top-20. It therefore has more internal retrieval opportunities than the one-pass arms. **Because qrels have not been scored, no retrieval configuration has been shown to be the best validated arm; E* is a standalone cost/feasibility probe and does not yet satisfy the TRD's final “best validated configuration + Iterative Planner” arm.** Planner latency was P50 8,629.5 ms / P95 11,647.8 ms; retrieval latency was P50 703.7 ms / P95 1,175.0 ms. The loopback bridge reported 415,247 input and 975 output tokens across 24 calls: 34,603.9 input tokens per query on average. Monetary billing is not exposed by this local bridge, so a currency cost is unavailable; token counts are reported instead.

### E prompt-cost bad case

The recorded input volume is consistent with the current second-round prompt construction: IterativeEvidenceAcquirer passes up to three full retrieved chunk contents as previous_evidence, and the planner includes them without a character/token cap. The run records usage summed per query, not per round, so an exact token split between first- and second-round calls is unavailable. This is a measured prompt-cost problem, not evidence of retrieval-quality improvement or a model failure. The frozen run was not changed after observing it; a bounded evidence-context variant should be a separate future ablation.

### Sparse latency bad case

BM25 P95 is dominated by two bilingual draft queries, not only by cold start. The tokenizer expands Chinese into overlapping bigrams and joins every unique term with OR:

| Query ID | Category | Unique terms | Chunks matching the FTS expression | Observed BM25 time |
|---|---|---:|---:|---:|
| H2-P-007 | bilingual | 19 | 778,408 | 3,869.7 ms |
| H2-P-008 | bilingual | 17 | 803,301 | 3,735.7 ms |

These are retained as measured performance limitations. No tokenizer, query, cohort, or qrel was changed after observing the timings.

## Full quality-evaluation gate

The original A–D pool had 461 query–document candidates. E added 78 candidates outside that pool, so the frozen A–E pool has 539 query–document candidates across the same 12 queries. The v2 pool includes candidates from all five arms. The old reviewer workbooks remain available as artifacts, but the new TRD says not to make manual Excel completion the default gate; they have not supplied external labels and were not used for the smoke score.

Only H2-P-001 has a model-fallback smoke judgment. The remaining 11 questions have no judged pool. The complete 12-question A–E comparison, category results, answerability, evidence-support rate, agreement with external Gold, and answer-generation support remain unmeasured. The pilot is too small for a method conclusion, and the current local GPT-6-Luna judge route is not authenticated. No BioASQ files were found in the local corpus or the known MedCorp roots; the local V4 30-case/90-task fixture is a patient-workflow benchmark, not a source-grounded RAG retrieval set, so it is not being relabeled as one. Pooled Recall will measure recovery of judged candidates, not exhaustive recall over all 823,450 chunks.

The new blinded workbooks and machine-readable integrity record are under the Git-ignored services/health-engine/data/local-rag-hc-rag-002/sparse-eval/h2-pilot-v2/ directory. The A–D and E run JSONs remain under the v1 run directory and are referenced by hash in the v2 integrity record. The three-question seed's A–D runs are under the ignored `h2-source-seed-20261015/` directory and its compact hash-bound anchor score is tracked in `eval/rag-retrieval/results/`.

## Health Engine trace

One single-mode query was executed through RagService.search over the same local Qwen corpus. It returned three EvidenceHits in an EvidenceSet: one retrieval call, zero planner calls, 683.5 ms request latency, and no patient/memory input. The full local trace is services/health-engine/data/local-rag-hc-rag-002/sparse-eval/h2-pilot-v1/trace-healthengine-evidence-set.json.

## Remaining H2 work

- Reach 300 quality-checked questions with fixed 100 DEV / 200 HOLDOUT; first validate source-grounded generation, semantic deduplication and category balance without downloading new corpora or rebuilding the Qwen index.
- The local OpenAI-compatible route is still unauthorized; the authenticated Codex CLI route works but the first one-question run used 76,605 input tokens. Establish a lower-overhead, bounded batching path, then run blinded labels, review low-confidence/parse-failure/disagreement cases, and preserve raw outputs. The one-question CLI result remains diagnostic only.
- Run A–E under one frozen question set and candidate budget; add evidence-sufficiency adaptive F only after the DEV policy and stop criteria are fixed. Evaluate final-generation support on at least 100 questions using one fixed generator and prompt.
- Report relevance and support metrics by split/category, paired deltas and deterministic bootstrap intervals; compare judge labels with an external-Gold subset if a license-compatible set can be obtained.
- Produce at least 15 real failure analyses, including at least 10 retrieval/coverage/support failures, and a version-bound final report.
- Only after labels exist, analyze at least 10 relevance/coverage Bad Cases. Current verified bad cases are performance/cost observations; they do not establish a relevance failure.
- Current cost/performance observations are listed in H2-PERFORMANCE-BAD-CASES.md; the attached ChatGPT analysis and corrected interview wording are reviewed in H2-CHATGPT-ANALYSIS-REVIEW.md.
- Phase D source-metadata gaps are audited in H2-PHASE-D-METADATA-AUDIT.md. The separate citation-ID and claim-support protocol is in H2-PHASE-D-EVIDENCE-SUPPORT-PROTOCOL.md, with a machine-readable query-to-EvidenceSet example in H2-TRACE-EXAMPLE.json. Source authority and applicability have not been inferred from corpus names.
- No Health Engine or DSH product behavior, API contract, active FAISS index, model weights, or source corpus changed in this pilot.
