import type { EvidenceSet } from './contracts.js'

/** Render only citation-relevant source fields; omit internal query traces and index metadata. */
export function renderEvidenceSet(value: EvidenceSet): string {
  const rendered = {
    query: value.query,
    mode: value.mode,
    corpusVersion: value.corpusVersion,
    retrieval: {
      rounds: value.retrieval.rounds,
      generatedQueries: value.retrieval.generatedQueries,
      uniqueDocuments: value.retrieval.uniqueDocuments,
      candidateCount: value.retrieval.candidateCount,
      returnedEvidenceCount: value.retrieval.returnedEvidenceCount,
      retrievalCalls: value.retrieval.retrievalCalls,
      plannerCalls: value.retrieval.plannerCalls,
      retrievalLatencyMs: value.retrieval.retrievalLatencyMs,
      plannerLatencyMs: value.retrieval.plannerLatencyMs,
      latencyMs: value.retrieval.latencyMs,
      estimatedContextTokens: value.retrieval.estimatedContextTokens,
      plannerModel: value.retrieval.plannerModel,
      plannerPromptVersion: value.retrieval.plannerPromptVersion,
      ...(value.retrieval.plannerInputTokens === undefined ? {} : { plannerInputTokens: value.retrieval.plannerInputTokens }),
      ...(value.retrieval.plannerOutputTokens === undefined ? {} : { plannerOutputTokens: value.retrieval.plannerOutputTokens }),
      generatedQueryHashes: value.retrieval.generatedQueryHashes,
      degraded: value.retrieval.degraded,
      ...(value.retrieval.degradedErrorClass === undefined ? {} : { degradedErrorClass: value.retrieval.degradedErrorClass }),
    },
    hits: value.hits.map(hit => ({
      evidenceId: hit.evidenceId,
      rank: hit.rank,
      title: hit.title,
      snippet: hit.snippet,
      corpus: hit.corpus,
      sourceType: hit.sourceType,
      sourceDocumentId: hit.sourceDocumentId,
      ...(hit.sourceUri === undefined ? {} : { sourceUri: hit.sourceUri }),
      score: hit.score,
      retrievalRound: hit.retrievalRound,
      snippetTruncated: hit.snippetTruncated,
    })),
  }
  return JSON.stringify(rendered)
}
