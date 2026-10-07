# Health-Copilot engineering lessons reviewed for HC-RAG-001

This is a design review of the local Health-Copilot reference checkout, not a code port.

| Inspected reference | Reusable lesson | HC-RAG-001 application |
|---|---|---|
| `docs/m5_retrieval.md`, `tests/test_m5_retrieval.py` | Keep the upper evidence contract independent of the retrieval backend. Bind indexes to the corpus/model revision and fail closed on manifest mismatch. Use deterministic identity tie breaks and deduplicate stable source IDs. | `EvidenceSet` is backend-neutral; `CorpusRepository` validates hashes and counts; MedCPT ranking uses stable chunk IDs. Hybrid fusion and reranking remain out of scope. |
| `docs/m5_retrieval.md` | Treat corpus-uncovered controls as retrieval diagnostics, not proof that every returned nearest neighbor is answerable. Do not compare uncalibrated scores from different rankers. | The live unsupported query is recorded as a weak-result test: DSH explicitly abstained from citing its nearest candidates. No score threshold is claimed or tuned from this tiny sample. |
| `docs/m7_eval.md`, `tests/test_runtime_trace.py` | Separate product behavior from retrieval quality; keep deterministic offline tests distinct from live provider runs. Metadata traces should reject medical question, answer, and evidence content. Keep infrastructure errors visible rather than folding them into quality failures. | The suite has deterministic fixture tests plus explicit local live DSH turns. `live-trace.jsonl` records event/control-flow metadata only; service-unavailable and cancellation outcomes are separate from retrieval success. |
| `docs/m7_eval.md` | Bind evaluations to frozen suite/configuration identity and report denominators and limitations; a tiny focused slice is a diagnostic, not a generalization claim. | HC-RAG metrics list each live case, tool calls, hits, planner calls, rounds, latency, corpus version, and the small 93-chunk sample limitation. No accuracy-improvement claim is made. |
| `README.md`, `docs/m5_retrieval.md` | Keep downloaded corpora and model weights outside Git; run local-only and avoid implicit network access during runtime. | Corpus/index preparation is explicit, the service loads a local manifest, and live startup is offline/local-only. |

Health-Copilot HEAD at review time was `f735285b2cda4e1bf5fd5a91f961a1510cdc0c77`; the inspected M5 retrieval/evaluation checkpoint is documented there as `main@a69801bde6826daaf02aa933c2cdf2a05697d42a`. The reference working tree also had unrelated uncommitted changes, which were left untouched.

The old product's AgentLoop, Session, orchestration, runtime policy, and answer ownership are not imported. DSH remains Huiyi's only outer Agent runtime. Health-Copilot is used only as an engineering reference for evidence contracts, retrieval evaluation, provenance, bounded budgets, failure taxonomy, and trace redaction.
