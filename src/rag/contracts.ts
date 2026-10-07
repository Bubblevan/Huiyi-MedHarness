export type RagMode = 'single' | 'iterative'

export interface MedicalEvidenceRequest {
  query: string
  topK?: number
  mode?: RagMode
}

export interface EvidenceHit {
  evidenceId: string
  rank: number
  title: string
  snippet: string
  /** Kept for compatibility with the original F0 hit shape. */
  source: string
  sourceType: string
  corpus: string
  sourceDocumentId: string
  chunkId: string
  score: number
  retrievalQuery: string
  retrievalQueries: string[]
  retrievalRound: number
  snippetTruncated: boolean
  sourceUri?: string
}

export interface EvidenceSet {
  query: string
  mode: RagMode
  hits: EvidenceHit[]
  retrieval: {
    rounds: number
    generatedQueries: number
    uniqueDocuments: number
    candidateCount: number
    returnedEvidenceCount: number
    retrievalCalls: number
    plannerCalls: number
    retrievalLatencyMs: number
    plannerLatencyMs: number
    latencyMs: number
    estimatedContextTokens: number
    plannerModel: string
    plannerPromptVersion: string
    plannerInputTokens?: number
    plannerOutputTokens?: number
    generatedQueryHashes: string[]
    degraded: boolean
    degradedErrorClass?: string
  }
  corpusVersion: string
}

export interface MedicalEvidenceClientPort {
  search(request: MedicalEvidenceRequest, options?: { signal?: AbortSignal }): Promise<EvidenceSet>
  health(options?: { signal?: AbortSignal }): Promise<{ status: 'ok' }>
}

export function validateMedicalEvidenceRequest(input: unknown): MedicalEvidenceRequest & { query: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('arguments must be an object')
  }
  const candidate = input as Record<string, unknown>
  if (typeof candidate.query !== 'string' || candidate.query.trim().length === 0) {
    throw new TypeError('query must be a non-empty string after trimming')
  }
  const topK = candidate.topK
  if (topK !== undefined && (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > 10)) {
    throw new RangeError('topK must be an integer between 1 and 10')
  }
  const mode = candidate.mode
  if (mode !== undefined && mode !== 'single' && mode !== 'iterative') throw new TypeError('mode must be single or iterative')
  return {
    query: candidate.query.trim(),
    ...(topK === undefined ? {} : { topK: topK as number }),
    ...(mode === undefined ? {} : { mode }),
  }
}
