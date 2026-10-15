# H2 RAG Quality Pilot — 2026-10-15

## Result status

**Exploratory only; strict-qrel score supersedes the initial 12-row table.** Retrieval-quality metrics are available, not just latency. Standard metrics now use only questions whose entire pooled candidate set has resolved labels and whose returned Top-K documents are in that pool. Three questions are excluded because five pooled labels remain unresolved; the valid A–E/translation comparison denominator is nine. This is still a small DEV pilot with GPT-6-Luna labels, not clinician or external gold.

## Why performance metrics appeared later

Latency and execution success can be measured from a retrieval run alone; relevance performance cannot. It needs query-specific relevance labels for retrieved candidates. The first full-pool judge route returned HTTP 401, so the early work could only report latency plus one-query/source-anchor diagnostics. Those tiny diagnostics were not a sound A/B quality comparison. The Codex CLI judgment path later supplied labels for the 12-query DEV pilot, and the scorer was tightened so unresolved candidates are excluded instead of silently treated as irrelevant. That produced the quality table below. The delay was a missing-label/evaluation-data problem, not a reason to deprioritize retrieval quality.

The resulting performance metrics are real measurements, but the eligible sample is small: n=9 for nDCG/MRR and n=6 for direct-support Precision/Recall. Both multi-hop questions are excluded, no-answer answerability remains unreviewed, and the same GPT-6-Luna model generated English translations and judged relevance. Therefore the pilot can identify hypotheses and regressions, but cannot establish generalization, clinical answer quality, or a production winner.

## Frozen evaluation

- Dataset: `h2-pilot-dev-draft-v1`, 12 DEV questions, six categories (two each).
- Corpus: `medtext-local-cc7d43568501e6b7`, five-source Qwen3-Embedding-0.6B corpus; manifest SHA-256 `ccc89d1f6deef68536647541fbad6c79c98f7185cfbe2cd0c00698b15f5b37cf`.
- Retrieval-run source revision: `28ba197ed3499272efdfaeda20645be7300ec796`; exact run file hashes are embedded in the score JSON.
- Relevance grades: 0 irrelevant, 1 partial/contextual, 2 direct support. The augmented pool contains 626 query-document pairs: the original 539 A–E candidates plus 87 new English-translation Top-10 candidates. Qrels remain pooled, not exhaustive over the 823,450-chunk corpus.
- Judge: read-only Codex CLI, `gpt-6-luna`, blinded to method, rank, score, source name and document ID. This is model-assisted relevance judgment, not a clinician review.
- Label coverage: original 535/539 resolved. The translation extension added 87 candidate pairs; 86 passed first/second-pass criteria and one disagreement remains excluded. The combined pool has **621/626 resolved labels (99.2%)**. Of 24 blinded old-label controls, the first pass matched 21; a second pass matched all three discrepant controls to their prior adjudicated grades (24/24 final agreement). This is same-model consistency checking, not external validation.
- Scoring: paired bootstrap, 10,000 resamples, fixed seed `20261015`. Queries with any unresolved pool label or any unpooled Top-K result are excluded from standard metrics; unresolved items are never scored as grade 0. Nine of 12 questions are eligible at K=5/10; direct-support P/R metrics have six eligible questions. Score status is `exploratory_only`.
- Original A–E qrel judging usage: 1,508,252 input tokens (1,293,312 cached), 89,722 output tokens and 46,373 reasoning tokens across first and second passes.

## Retrieval quality

| Arm | nDCG@10 (n=9) | MRR@10 (n=9) | Precision@5 (n=6) | Pooled Recall@5 (n=6) | Δ nDCG@10 vs Dense (paired 95% bootstrap CI) |
|---|---:|---:|---:|---:|---:|
| A · Dense | 0.6130 | 0.2722 | 0.2667 | 0.2583 | — |
| B · BM25 | 0.1694 | 0.0833 | 0.0667 | 0.1111 | −0.4436 (−0.6425, −0.2571) |
| C · Dense + BM25 / RRF | 0.3826 | 0.2214 | 0.1667 | 0.1542 | −0.2304 (−0.3479, −0.1186) |
| D · RRF + BGE reranker | 0.6062 | **0.3704** | **0.4000** | **0.4014** | −0.0068 (−0.0999, +0.0957) |
| E* · Dense + iterative GPT-6-Luna planner | **0.6748** | 0.3333 | 0.3000 | 0.2417 | +0.0618 (−0.0146, +0.1428) |
| BM25 + English lexical query translation† | 0.4829 | 0.2917 | 0.1333 | 0.1875 | — |

† Separate query-expansion diagnostic; not part of frozen A–E or production behavior. It is compared directly with BM25 below. Precision@5 and Pooled Recall@5 use only six questions with at least one resolved grade-2 qrel; denominators are not nine or twelve. All reported standard metrics require complete qrels for the question's entire pool.

### Category nDCG@10 (eligible question counts vary)

| Category | Dense | BM25 | RRF | Reranker | Iterative | English BM25† |
|---|---:|---:|---:|---:|---:|---:|
| Bilingual (n=2) | 0.6384 | 0.5333 | 0.5597 | 0.7485 | 0.6445 | 0.5753 |
| Exact term (n=2) | 0.6830 | 0.1920 | 0.5445 | 0.7511 | 0.7493 | 0.6288 |
| Multi-hop (n=0) | — | — | — | — | — | — |
| No-answer (n=2) | 0.2813 | 0.0367 | 0.0882 | 0.0997 | 0.4401 | 0.3379 |
| Semantic (n=1) | 0.6944 | 0.0000 | 0.3091 | 0.6944 | 0.6944 | 0.4330 |
| Source conflict (n=2) | 0.8084 | 0.0000 | 0.3746 | 0.7812 | 0.8553 | 0.4145 |

## BM25 cross-language query-translation comparison (separate arm)

To test whether the Chinese BM25 failures are partly caused by sparse vocabulary mismatch, GPT-6-Luna produced English lexical query translations for all 12 frozen DEV queries, then the same read-only FTS5 index was queried with OR/Top-20. No answer was generated; no corpus/index changed. Top-10 candidates were added to the blind qrel pool, and all A–E methods were rescored against that same augmented pool.

The augmented pool added 87 query-document pairs. The blind pass included 24 previously judged controls; the first pass matched 21/24 control labels, and an independent second pass matched all three disagreements to their prior adjudicated labels. For new candidates, 86/87 labels were accepted after exact-quote/confidence checks and second-pass agreement; one grade disagreement remains excluded. The entire qrel pool now has 621/626 resolved labels, with five unresolved candidates across three questions.

| Variant | nDCG@10 (n=9) | MRR@10 (n=9) | Precision@5 (n=6) | Pooled Recall@5 (n=6) |
|---|---:|---:|---:|---:|
| Original Chinese BM25 | 0.1694 | 0.0833 | 0.0667 | 0.1111 |
| English lexical translation + BM25 | 0.4829 | 0.2917 | 0.1333 | 0.1875 |

On the nine eligible paired questions, translation improves nDCG@10 by **+0.3135** vs original BM25 (10,000-resample 95% percentile CI **[+0.1636, +0.4624]**) and MRR@10 by +0.2083 (CI [+0.0556, +0.4028]). The improvement is strongest on H2-P-002: no known direct-support result in original BM25 Top-20, versus a resolved grade-2 result at rank 2 after translation. This is a notable small-pilot performance signal and makes cross-language lexical mismatch a testable BM25 failure mechanism.

The eligible sample is still only nine questions; qrels are produced by GPT-6-Luna, which also generated the English queries, so model-specific bias is possible. The three excluded questions include both multi-hop cases; those category results are unavailable. The two no-answer-intended questions still have pending answerability gold, so retrieval nDCG is not a false-support/abstention measurement. This is not holdout evidence or a production-ready change.

An earlier known-qrel-only lower-bound probe is preserved in `h2-pilot-v2-bm25-english-translation-known-qrels-20261015.json`; it was intentionally not used as the final score once new candidates were judged. Full score and paired deltas are in `h2-pilot-v2-english-top10-augmented-score-20261015.json`.

## What this does and does not show

- On the nine complete-qrel questions, plain BM25 and the current RRF configuration rank below Dense. The reranker improves P@5 and pooled R@5 point estimates over Dense, while its nDCG@10 delta is near zero and the paired interval crosses zero.
- Iterative retrieval has the highest nDCG@10 point estimate among frozen A–E (0.6748 vs Dense 0.6130), but its paired delta is +0.0618 with CI [−0.0146, +0.1428]. It used two retrieval rounds and up to 40 raw candidate slots; GPT-6-Luna also served as the relevance judge, so this is neither compute-matched nor independently validated.
- The English lexical translation diagnostic improves nDCG@10 vs original BM25 by +0.3135 on the same nine eligible queries (paired CI [+0.1636, +0.4624]). This is a promising retrieval-quality signal, but the sample is small and the same model generated queries and judged relevance; confirm on a larger DEV set and untouched HOLDOUT before considering a production change.
- The two no-answer questions do not measure whether a generated answer abstains or makes unsupported claims. No-answer false-support and final-answer evidence support remain unmeasured.
- Pooled Recall is recall over documents retrieved by the compared arms and included in the qrel pool, not full-corpus recall. No external-gold agreement or human review has been performed.
- Category results are diagnostic only: the two multi-hop questions are both ineligible due to unresolved pooled labels, semantic has n=1, and other categories have n=2. This pilot cannot establish robust category-level comparisons.
- The revised scorer no longer treats unresolved labels as irrelevant. Its full-pool completeness gate reduced the standard-metric denominator from 12 to 9; the initial all-12 score remains as a historical artifact but is superseded.

## Reproduction artifacts

- Machine labels: [`h2-pilot-v2-codex-cli-judge-run.json`](../../eval/rag-retrieval/results/h2-pilot-v2-codex-cli-judge-run.json)
- Second-pass adjudication: [`h2-pilot-v2-codex-cli-judge-adjudication.json`](../../eval/rag-retrieval/results/h2-pilot-v2-codex-cli-judge-adjudication.json)
- A–E score and per-question rows: [`h2-pilot-v2-codex-cli-judge-score.json`](../../eval/rag-retrieval/results/h2-pilot-v2-codex-cli-judge-score.json)
- Current strict-qrel A–E + English-translation score and all paired deltas: [`h2-pilot-v2-english-top10-augmented-score-20261015.json`](../../eval/rag-retrieval/results/h2-pilot-v2-english-top10-augmented-score-20261015.json)
- Translation lower-bound diagnostic, superseded after incremental judging: [`h2-pilot-v2-bm25-english-translation-known-qrels-20261015.json`](../../eval/rag-retrieval/results/h2-pilot-v2-bm25-english-translation-known-qrels-20261015.json)
- Blind-packet preparation, qrel finalization, strict scorer and tests: [`prepare_h2_translation_top10_blind_packet.py`](../../eval/rag-retrieval/prepare_h2_translation_top10_blind_packet.py), [`finalize_h2_translation_top10_qrels.py`](../../eval/rag-retrieval/finalize_h2_translation_top10_qrels.py), [`score_judge_runs.py`](../../eval/rag-retrieval/score_judge_runs.py)
- Full phase record: [`H2-PHASE-B-RUN-STATUS.md`](H2-PHASE-B-RUN-STATUS.md)

Combined GPT-6-Luna CLI usage for the original qrels, English query generation and incremental judging is 1,727,835 input tokens (1,441,024 cached), 106,414 output tokens and 54,024 reasoning tokens. The results include dataset, corpus, candidate-pool, prompt, raw-output, event-log, retrieval-run and scoring-code hashes. Raw candidate text and ignored retrieval pools remain local; tracked judgment artifacts keep exact-quote verification and quote hashes without redistributing passage text.
