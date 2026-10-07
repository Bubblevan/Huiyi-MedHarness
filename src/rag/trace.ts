export interface RagTraceMetadata {
  ragMode?: 'single' | 'iterative'
  retrievalRounds?: number
  generatedQueryCount?: number
  uniqueEvidenceCount?: number
  candidateCount?: number
  returnedEvidenceCount?: number
  retrievalCalls?: number
  plannerCalls?: number
  retrievalLatencyMs?: number
  plannerLatencyMs?: number
  ragLatencyMs?: number
  estimatedContextTokens?: number
  corpusVersion?: string
  plannerModel?: string
  plannerPromptVersion?: string
  plannerInputTokens?: number
  plannerOutputTokens?: number
  generatedQueryHashes?: string[]
  degraded?: boolean
  degradedErrorClass?: string
}

/** Extract only counters and versions; never return query, snippet, or model output. */
export function ragTraceMetadata(content: unknown): RagTraceMetadata | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') continue
    try {
      const envelope: unknown = JSON.parse(block.text)
      if (!isRecord(envelope) || (envelope.mode !== 'single' && envelope.mode !== 'iterative')
        || !isRecord(envelope.retrieval) || !Array.isArray(envelope.hits)) continue
      const meta = envelope.retrieval
      if (!Number.isInteger(meta.rounds) || !Number.isInteger(meta.generatedQueries)
        || !Number.isInteger(meta.uniqueDocuments) || !Number.isInteger(meta.candidateCount)
        || !Number.isInteger(meta.returnedEvidenceCount) || !Number.isInteger(meta.retrievalCalls)
        || !Number.isInteger(meta.plannerCalls) || typeof meta.retrievalLatencyMs !== 'number'
        || typeof meta.plannerLatencyMs !== 'number' || typeof meta.latencyMs !== 'number'
        || !Number.isInteger(meta.estimatedContextTokens) || typeof meta.plannerModel !== 'string'
        || typeof meta.plannerPromptVersion !== 'string' || !Array.isArray(meta.generatedQueryHashes)
        || !meta.generatedQueryHashes.every(hash => typeof hash === 'string')
        || (meta.plannerInputTokens !== undefined && !Number.isInteger(meta.plannerInputTokens))
        || (meta.plannerOutputTokens !== undefined && !Number.isInteger(meta.plannerOutputTokens))
        || typeof envelope.corpusVersion !== 'string'
        || typeof meta.degraded !== 'boolean') continue
      return {
        ragMode: envelope.mode,
        retrievalRounds: meta.rounds as number,
        generatedQueryCount: meta.generatedQueries as number,
        uniqueEvidenceCount: envelope.hits.length,
        candidateCount: meta.candidateCount as number,
        returnedEvidenceCount: meta.returnedEvidenceCount as number,
        retrievalCalls: meta.retrievalCalls as number,
        plannerCalls: meta.plannerCalls as number,
        retrievalLatencyMs: meta.retrievalLatencyMs,
        plannerLatencyMs: meta.plannerLatencyMs,
        ragLatencyMs: meta.latencyMs,
        estimatedContextTokens: meta.estimatedContextTokens as number,
        corpusVersion: envelope.corpusVersion,
        plannerModel: meta.plannerModel,
        plannerPromptVersion: meta.plannerPromptVersion,
        ...(meta.plannerInputTokens === undefined ? {} : { plannerInputTokens: meta.plannerInputTokens as number }),
        ...(meta.plannerOutputTokens === undefined ? {} : { plannerOutputTokens: meta.plannerOutputTokens as number }),
        generatedQueryHashes: meta.generatedQueryHashes as string[],
        degraded: meta.degraded,
        ...(typeof meta.degradedErrorClass === 'string' ? { degradedErrorClass: meta.degradedErrorClass } : {}),
      }
    } catch {
      // Other tool results are not RAG EvidenceSets.
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
