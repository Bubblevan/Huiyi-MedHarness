Read-only evaluation task. Open services/health-engine/data/local-rag-hc-rag-002/sparse-eval/h2-source-seed-20261015/annotation-packet.blinded.json and process only questionId H2-SG-001. This is automated information-retrieval relevance labeling, not clinical review or advice. Use only the query and candidate snippets in that file; do not use outside medical knowledge.

For every candidate in that question's candidatePool, emit exactly one judgment:
- relevance 2: snippet directly provides factual evidence needed to answer the query;
- relevance 1: related context but not sufficient to answer it;
- relevance 0: irrelevant to the query.
For nonzero grades, evidence_quote must be an exact substring of that candidate's snippet. Set answer_support to direct, partial, or none. Set conflict_type to none unless the snippet explicitly conflicts with another supplied snippet. Give confidence from 0 to 1 and a concise reason. Use candidateId exactly as provided.

Return only one JSON object with keys questionId and judgments. Each judgment must have candidateId, relevance, answer_support, evidence_quote, conflict_type, confidence, reason. Include each candidate exactly once. Do not output document IDs, methods, ranks, retrieval scores, or an overall recommendation. Never claim that a machine label is human clinical review.
