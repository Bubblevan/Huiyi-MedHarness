# Huiyi H2 retrieval evaluation

This package is an offline evaluation boundary. It does not change the Health Engine request path or DSH's outer AgentLoop.

Current quality-evaluation target and status are recorded in [`H2-PHASE-B-RUN-STATUS.md`](../../docs/rag/H2-PHASE-B-RUN-STATUS.md). The 12-question A–E set now has an exploratory quality score, but it is not a validated method result; the current target is 100 DEV + 200 HOLDOUT. Do not present latency or run success as retrieval-quality evidence. The current score and limits are summarized in [`H2-PILOT-QUALITY-SCORE-20261015.md`](../../docs/rag/H2-PILOT-QUALITY-SCORE-20261015.md).

The 100-DEV / 200-HOLDOUT v12 A–D retrieval-quality results are in [`H2-QUALITY-CLOSEOUT-20261016.md`](../../docs/rag/H2-QUALITY-CLOSEOUT-20261016.md), with machine-readable [HOLDOUT scores](../../docs/rag/H2-QUALITY-HOLDOUT-SCORE-20261016.json) and [HOLDOUT bad cases](../../docs/rag/H2-QUALITY-HOLDOUT-BAD-CASES-20261016.json). The older 12-question pilot remains historical; E, adaptive sufficiency F and final-answer support evaluation remain open.

The deterministic three-question source-anchor check is in [`results/h2-source-anchor-seed-20261015.json`](results/h2-source-anchor-seed-20261015.json). It checks whether each method retrieves the exact chunk used to author a diagnostic query; the anchors are not independent/expert qrels, and the 3-question ceiling result is not a method comparison.

## Files

- build_review_workbooks.mjs: merge a completed iterative E run into the frozen A–D pool, create the A–E blinded packet, and export two independently randomized reviewer workbooks. The sheets hide original question IDs and task categories as well as methods, rank, and scores. This is an annotation-material generator only; it does not create labels or scores. It uses the local Codex artifact-tool runtime plus the existing Health Engine corpus files.
- run_iterative_pilot.py: bounded, offline-corpus E-arm runner using the existing Qwen retriever and an explicitly configured local GPT-6-Luna planner route. It generates retrieval queries only and writes a retrieval run, not an answer or a quality score.
- Evidence-support protocol and trace summary: see docs/rag/H2-PHASE-D-EVIDENCE-SUPPORT-PROTOCOL.md and docs/rag/H2-TRACE-EXAMPLE.json for the separate citation-ID, source-resolution, and claim-support measurement contract.

The current 12-query A–E pilot and review packet are under the Git-ignored local Health Engine data directory. Once the E run exists, execute build_review_workbooks.mjs once to create the versioned v2 packet; it refuses to overwrite existing outputs.

- [`schema.json`](schema.json): versioned qrels dataset shape.
- [`score.py`](score.py): reviewed-qrels validation, retrieval metrics, annotator agreement, failure-preserving per-query report.
- [`judge_pool.py`](judge_pool.py): blind LLM-as-Judge over pooled candidates; validates candidate coverage, 0/1/2 relevance, exact snippet quotes, support/conflict fields, confidence, and preserves raw outputs. Failed or missing judgments remain unresolved.
- [`score_judge_runs.py`](score_judge_runs.py): scores machine-judge outputs against the private candidate-to-document map; reports graded nDCG, direct-support and context Precision/Recall/MRR, per-metric denominators, categories, all paired query deltas, and deterministic bootstrap intervals. A query is excluded from standard metrics if its pooled qrels are incomplete or a Top-K result is unpooled; unresolved labels are never implicitly scored as grade 0. `--allow-review-required` explicitly opts into unresolved labels.
- [`resolve_h2_judge_review.py`](resolve_h2_judge_review.py): validates blinded second-pass coverage, exact quotes, confidence, and agreement; unresolved labels remain excluded. Tracked output hashes quotes rather than copying corpus excerpts.
- [`analyze_h2_quality_bad_cases.py`](analyze_h2_quality_bad_cases.py): extracts qrel-grounded method/query comparisons with top-5 evidence references; no-answer risks are kept separate from observed retrieval regressions.
- [`probe_bm25_conjunction.py`](probe_bm25_conjunction.py): read-only diagnostic on the existing FTS5 index; tests AND/OR and accepts a complete hash-bound English lexical query-translation map without changing the frozen A–E runs or rebuilding the index.
- [`score_known_qrel_probe.py`](score_known_qrel_probe.py): scores a new probe only against already resolved pooled qrels, reports known-qrel recall/MRR and judged/unjudged counts, and never treats unseen candidates as irrelevant or reports invalid precision/nDCG.
- [`test_judge_pool.py`](test_judge_pool.py) and [`test_score_judge_runs.py`](test_score_judge_runs.py): structured-output, blinding, quote-validation, missing-label, and metric tests.
- [`sparse_index.py`](sparse_index.py): separately built SQLite FTS5 sparse index, pinned to the Qwen corpus manifest; not used by Health Engine.
- [`run_pilot_pool.py`](run_pilot_pool.py): local-only Dense/BM25/RRF/BGE candidate pooling for the draft DEV pilot; writes blinded review input and method runs without scoring.
- The D arm's per-query `latencyMs` is sequential RRF retrieval plus warm reranker-stage time. One-time reranker/model loading is reported separately at run level. Older frozen runs that stored only reranker-stage time must use the explicit derived scoring run documented in the H2 run status.
- [`pilot-queries.draft.json`](pilot-queries.draft.json): 12-question six-category DEV draft. Answerability and qrels remain pending until independent review.
- [`test_score.py`](test_score.py): deterministic fixtures for metrics, qrels gating, version mismatch, agreement, and failed attempts.
- [`test_sparse_index.py`](test_sparse_index.py): tokenizer, contentless-index, version and manifest-hash checks on a tiny temporary corpus.

## Dataset contract

Freeze `datasetId`, split, `corpusVersion`, question IDs, query text, language, category, answerability evidence, source anchors and query hash. Active machine-judge labels use 0/1/2 and record `answer_support`, exact `evidence_quote`, `conflict_type`, explanation, confidence, model/prompt versions and raw output. Method, rank, score, original question ID and category stay out of the judge prompt. Low-confidence, uncertain, malformed, absent and failed labels remain review-required or unresolved; they are never defaulted to nonrelevance. The legacy `score.py` and double-review schema retain their 0–3 human-label contract and must not be mixed with the machine-label scale.

Machine qrels are 0/1/2: 0 irrelevant; 1 topical/contextual or supports a limited aspect; 2 direct support for a material requested element. `answer_support` is a separate axis: a grade-1 passage can still be `unsupported` for the specific requested fact, including patient-specific facts absent from the medical knowledge corpus. This separation is required to measure false support on no-answer tasks. Machine nDCG uses gain `2^grade - 1`; primary direct-support Precision/Recall/MRR use grade 2 and separate context metrics include grade 1. Legacy human qrels scored by `score.py` remain 0–3, with grade ≥2 relevant. Do not mix them or claim either as clinical accuracy. A `no_answer` query requires a frozen corpus-scope rationale; absence from the candidate pool alone is not proof that the entire corpus lacks an answer.

For source conflict cases, retain each document as its own qrel and set applicability to `conflicting` where justified; never collapse different editions or sources into one document ID. For multi-hop cases, include every required evidence chunk as a relevant qrel, then score whether the fixed top-K recovers those chunks. Patient encounter and memory fields do not belong in this dataset.

The current run checkpoint and source-metadata gaps are documented in [`H2-PHASE-B-RUN-STATUS.md`](../../docs/rag/H2-PHASE-B-RUN-STATUS.md) and [`H2-PHASE-D-METADATA-AUDIT.md`](../../docs/rag/H2-PHASE-D-METADATA-AUDIT.md). Current run artifacts and reviewer workbooks are generated under the Git-ignored local Health Engine data directory; they are not source-controlled.

## Run contract

The runner writes UTF-8 JSON:

```json
{
  "schemaVersion": "huiyi-rag-retrieval-run/v1",
  "datasetId": "h2-pilot-dev-v1",
  "corpusVersion": "medtext-local-cc7d43568501e6b7",
  "method": "dense",
  "candidateBudget": 50,
  "decisionThreshold": null,
  "queries": [
    {
      "questionId": "H2D-001",
      "status": "ok",
      "latencyMs": 42.1,
      "plannerCalls": 0,
      "plannerInputTokens": 0,
      "plannerOutputTokens": 0,
      "abstained": false,
      "results": [
        { "documentId": "textbooks:doc-1:4", "source": "textbooks", "score": 0.72 }
      ]
    }
  ]
}
```

Every frozen question should have a run row. Missing rows are treated as execution failures with empty results and remain in the metric denominator. For any non-`ok` status, partial results are discarded for scoring while the failure status and observed latency remain in the record. Do not delete timeouts, errors, empty results or parse failures. Candidate count must not exceed the run's fixed budget.

## Score

The legacy human-label command below requires two-person annotation and adjudication:

```powershell
python eval/rag-retrieval/score.py `
  --dataset services/health-engine/data/local-rag-hc-rag-002/sparse-eval/h2-pilot-v2/pilot-queries.pending.json `
  --run services/health-engine/data/local-rag-hc-rag-002/sparse-eval/h2-pilot-v1/run-dense.json `
  --out services/health-engine/data/local-rag-hc-rag-002/sparse-eval/h2-pilot-v2/scores/h2-pilot-dense.json `
  --ks 5,10,20
```

Output includes macro Recall@K, MRR@K, graded nDCG@K and Precision@K over answerable questions; no-answer candidate/abstention summaries; per-query source counts, status, latency and planner token/call counts; execution success rate; P50/P95; reviewer agreement; and input SHA-256s. A/B comparison should use the same frozen question IDs and report paired per-query deltas. Because qrels are pooled rather than exhaustive over all 823,450 chunks, recall must be described as pooled-qrels Recall.

For the active machine 0–2 path, `judge_pool.py` can run against an authenticated local OpenAI-compatible endpoint, then `score_judge_runs.py` scores each frozen method run against the private candidate-to-document map. The configured loopback endpoint returned HTTP 401. A read-only Codex CLI GPT-6-Luna path has labeled 626 pooled candidate pairs across the 12-query DEV pilot; 621 are resolved, and standard metrics are eligible on nine complete-qrel questions. The score remains exploratory and cost-heavy (1.73M combined input tokens). The original A–E score is preserved but superseded because it treated unresolved labels as irrelevant in ranking metrics. The strict-qrel score and caveats are linked from the phase status report; raw snippets and retrieval pools remain local and ignored.

The scorer itself is method agnostic. Each experiment run must additionally freeze its source code SHA, manifest hash, model revision, tokenizer/reranker settings, candidate budget and exact command. `HOLDOUT` remains unopened until DEV tuning is complete.

## Sparse index preparation

BM25 uses SQLite FTS5 with a fixed title/body field weight of 3:1, `k1=1.2`, `b=0.75`, Unicode case-folded English words, and overlapping Chinese character bigrams. FTS5 stores token postings without duplicating source chunk text; a side table records stable document IDs and byte offsets into the frozen chunk JSONL. Every chunk file SHA-256 is checked while indexing. The index remains separate from FAISS and is accepted only when its corpus version and manifest hash match.

Example on the current local corpus (creates a derived file in the Git-ignored local data directory, with output and free-space guardrails):

```powershell
$python = "services/health-engine/.venv/Scripts/python.exe"
& $python eval/rag-retrieval/sparse_index.py `
  --corpus-root services/health-engine/data/local-rag-hc-rag-002/corpus `
  --manifest services/health-engine/data/local-rag-hc-rag-002/qwen3-corpus-manifest.json `
  --out services/health-engine/data/local-rag-hc-rag-002/sparse-eval/qwen3-bm25-v1.sqlite3 `
  --max-output-gib 8 `
  --min-free-gib 30
```

The builder refuses to overwrite an existing output and marks partial builds unusable. Its default cap is 8 GiB and it stops if free space falls below 30 GiB. It reads only the existing prepared chunk JSONL; it does not download or modify source corpora, FAISS files, model weights, or the Health Engine runtime.
