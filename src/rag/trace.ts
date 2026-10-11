export interface RagTraceMetadata {
  ragMode?: 'single' | 'iterative'
  retrievalRounds?: number
  generatedQueryCount?: number
  uniqueDocumentCount?: number
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
      if (!nonNegativeInteger(meta.rounds) || !nonNegativeInteger(meta.generatedQueries)
        || !nonNegativeInteger(meta.uniqueDocuments) || !nonNegativeInteger(meta.candidateCount)
        || !nonNegativeInteger(meta.returnedEvidenceCount) || !nonNegativeInteger(meta.retrievalCalls)
        || !nonNegativeInteger(meta.plannerCalls) || !nonNegativeNumber(meta.retrievalLatencyMs)
        || !nonNegativeNumber(meta.plannerLatencyMs) || !nonNegativeNumber(meta.latencyMs)
        || !nonNegativeInteger(meta.estimatedContextTokens) || typeof meta.plannerModel !== 'string'
        || meta.plannerModel.length > 256 || typeof meta.plannerPromptVersion !== 'string' || meta.plannerPromptVersion.length > 256
        || !Array.isArray(meta.generatedQueryHashes)
        || !meta.generatedQueryHashes.every(hash => typeof hash === 'string')
        || (meta.plannerInputTokens !== undefined && !nonNegativeInteger(meta.plannerInputTokens))
        || (meta.plannerOutputTokens !== undefined && !nonNegativeInteger(meta.plannerOutputTokens))
        || typeof envelope.corpusVersion !== 'string' || envelope.corpusVersion.length > 256
        || typeof meta.degraded !== 'boolean') continue
      return {
        ragMode: envelope.mode,
        retrievalRounds: meta.rounds as number,
        generatedQueryCount: meta.generatedQueries as number,
        uniqueDocumentCount: meta.uniqueDocuments as number,
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

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
