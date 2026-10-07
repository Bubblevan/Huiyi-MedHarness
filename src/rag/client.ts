import type { EvidenceSet, MedicalEvidenceClientPort, MedicalEvidenceRequest } from './contracts.js'

export type RagClientErrorKind = 'aborted' | 'timeout' | 'unavailable' | 'invalid_request' | 'backend' | 'invalid_response'

export class RagClientError extends Error {
  constructor(
    readonly kind: RagClientErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RagClientError'
  }
}

export interface RagClientOptions {
  baseUrl?: string
  timeoutMs?: number
  fetcher?: typeof fetch
}

export class RagClient implements MedicalEvidenceClientPort {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(options: RagClientOptions = {}) {
    const configured = new URL(options.baseUrl ?? process.env.HUIYI_HEALTH_ENGINE_URL ?? 'http://127.0.0.1:8322')
    if (configured.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(configured.hostname)
      || configured.username !== '' || configured.password !== ''
      || !['', '/'].includes(configured.pathname)
      || configured.search !== '' || configured.hash !== '') {
      throw new TypeError('Health-engine URL must be a loopback HTTP origin')
    }
    this.baseUrl = configured.origin
    const timeout = options.timeoutMs ?? Number(process.env.HUIYI_RAG_TIMEOUT_MS ?? 120000)
    this.timeoutMs = Number.isFinite(timeout) ? Math.max(1, Math.min(600000, Math.floor(timeout))) : 120000
    this.fetcher = options.fetcher ?? fetch
  }

  async health(options?: { signal?: AbortSignal }): Promise<{ status: 'ok' }> {
    const value = await this.request('/health', undefined, options?.signal, 10000)
    if (!isRecord(value) || value.status !== 'ok') throw new RagClientError('invalid_response', 'Health-engine returned an invalid health response')
    return { status: 'ok' }
  }

  async search(request: MedicalEvidenceRequest, options?: { signal?: AbortSignal }): Promise<EvidenceSet> {
    return decodeEvidenceSet(await this.request('/v1/rag/search', request, options?.signal, this.timeoutMs))
  }

  private async request(path: string, body: unknown | undefined, callerSignal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('request timeout'))
    }, timeoutMs)
    const onAbort = (): void => controller.abort(callerSignal?.reason)
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    if (callerSignal?.aborted) onAbort()

    try {
      let response: Response
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error: unknown) {
        if (callerSignal?.aborted) throw new RagClientError('aborted', 'Medical evidence request was cancelled')
        if (timedOut) throw new RagClientError('timeout', 'Medical evidence request timed out')
        throw new RagClientError('unavailable', `Health-engine request failed (${errorName(error)})`)
      }

      if (!response.ok) {
        const kind: RagClientErrorKind = response.status === 400 || response.status === 422
          ? 'invalid_request'
          : response.status === 408 || response.status === 504
            ? 'timeout'
            : response.status >= 500
              ? 'backend'
              : 'unavailable'
        throw new RagClientError(kind, `Health-engine returned HTTP ${response.status}`, response.status)
      }
      try {
        return await response.json() as unknown
      } catch {
        throw new RagClientError('invalid_response', 'Health-engine returned invalid JSON', response.status)
      }
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onAbort)
    }
  }
}

export function decodeEvidenceSet(value: unknown): EvidenceSet {
  if (!isRecord(value) || typeof value.query !== 'string'
    || (value.mode !== 'single' && value.mode !== 'iterative')
    || !Array.isArray(value.hits) || typeof value.corpusVersion !== 'string'
    || !isRecord(value.retrieval)
    || !hasOnlyKeys(value, ['query', 'mode', 'hits', 'retrieval', 'corpusVersion'])) {
    throw new RagClientError('invalid_response', 'Health-engine returned an invalid EvidenceSet')
  }

  const retrieval = value.retrieval
  if (!hasOnlyKeys(retrieval, [
    'rounds', 'generatedQueries', 'uniqueDocuments', 'candidateCount', 'returnedEvidenceCount',
    'retrievalCalls', 'plannerCalls', 'retrievalLatencyMs', 'plannerLatencyMs', 'latencyMs', 'estimatedContextTokens', 'plannerModel',
    'plannerPromptVersion', 'plannerInputTokens', 'plannerOutputTokens', 'generatedQueryHashes',
    'degraded', 'degradedErrorClass',
  ])) throw new RagClientError('invalid_response', 'Health-engine returned unexpected retrieval metadata')
  const integerFields = ['rounds', 'generatedQueries', 'uniqueDocuments', 'candidateCount', 'returnedEvidenceCount', 'retrievalCalls', 'plannerCalls', 'estimatedContextTokens']
  if (!integerFields.every(field => Number.isInteger(retrieval[field]) && (retrieval[field] as number) >= 0)
    || typeof retrieval.retrievalLatencyMs !== 'number' || !Number.isFinite(retrieval.retrievalLatencyMs) || retrieval.retrievalLatencyMs < 0
    || typeof retrieval.plannerLatencyMs !== 'number' || !Number.isFinite(retrieval.plannerLatencyMs) || retrieval.plannerLatencyMs < 0
    || typeof retrieval.latencyMs !== 'number' || !Number.isFinite(retrieval.latencyMs) || retrieval.latencyMs < 0
    || typeof retrieval.plannerModel !== 'string' || typeof retrieval.plannerPromptVersion !== 'string'
    || (retrieval.plannerInputTokens !== undefined && (!Number.isInteger(retrieval.plannerInputTokens) || (retrieval.plannerInputTokens as number) < 0))
    || (retrieval.plannerOutputTokens !== undefined && (!Number.isInteger(retrieval.plannerOutputTokens) || (retrieval.plannerOutputTokens as number) < 0))
    || !Array.isArray(retrieval.generatedQueryHashes) || !retrieval.generatedQueryHashes.every(hash => typeof hash === 'string')
    || typeof retrieval.degraded !== 'boolean'
    || (retrieval.degradedErrorClass !== undefined && typeof retrieval.degradedErrorClass !== 'string')) {
    throw new RagClientError('invalid_response', 'Health-engine returned invalid retrieval metadata')
  }

  const hits = value.hits.map((entry, index) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, [
      'evidenceId', 'rank', 'title', 'snippet', 'source', 'sourceType', 'corpus',
      'sourceDocumentId', 'chunkId', 'score', 'retrievalQuery', 'retrievalQueries',
      'retrievalRound', 'snippetTruncated', 'sourceUri',
    ]) || entry.rank !== index + 1 || !positiveInteger(entry.retrievalRound)
      || !['evidenceId', 'title', 'snippet', 'source', 'sourceType', 'corpus', 'sourceDocumentId', 'chunkId', 'retrievalQuery'].every(key => typeof entry[key] === 'string')
      || !Array.isArray(entry.retrievalQueries) || !entry.retrievalQueries.every(query => typeof query === 'string')
      || typeof entry.score !== 'number' || !Number.isFinite(entry.score) || typeof entry.snippetTruncated !== 'boolean'
      || (entry.sourceUri !== undefined && entry.sourceUri !== null && typeof entry.sourceUri !== 'string')) {
      throw new RagClientError('invalid_response', `Health-engine returned invalid evidence hit ${index + 1}`)
    }
    return {
      evidenceId: entry.evidenceId as string,
      rank: entry.rank as number,
      title: entry.title as string,
      snippet: entry.snippet as string,
      source: entry.source as string,
      sourceType: entry.sourceType as string,
      corpus: entry.corpus as string,
      sourceDocumentId: entry.sourceDocumentId as string,
      chunkId: entry.chunkId as string,
      score: entry.score,
      retrievalQuery: entry.retrievalQuery as string,
      retrievalQueries: entry.retrievalQueries as string[],
      retrievalRound: entry.retrievalRound as number,
      snippetTruncated: entry.snippetTruncated,
      ...(typeof entry.sourceUri !== 'string' ? {} : { sourceUri: entry.sourceUri }),
    }
  })
  if (retrieval.returnedEvidenceCount !== hits.length) throw new RagClientError('invalid_response', 'Evidence count does not match returned hits')

  return {
    query: value.query,
    mode: value.mode,
    hits,
    retrieval: {
      rounds: retrieval.rounds as number,
      generatedQueries: retrieval.generatedQueries as number,
      uniqueDocuments: retrieval.uniqueDocuments as number,
      candidateCount: retrieval.candidateCount as number,
      returnedEvidenceCount: retrieval.returnedEvidenceCount as number,
      retrievalCalls: retrieval.retrievalCalls as number,
      plannerCalls: retrieval.plannerCalls as number,
      retrievalLatencyMs: retrieval.retrievalLatencyMs,
      plannerLatencyMs: retrieval.plannerLatencyMs,
      latencyMs: retrieval.latencyMs,
      estimatedContextTokens: retrieval.estimatedContextTokens as number,
      plannerModel: retrieval.plannerModel,
      plannerPromptVersion: retrieval.plannerPromptVersion,
      ...(retrieval.plannerInputTokens === undefined ? {} : { plannerInputTokens: retrieval.plannerInputTokens as number }),
      ...(retrieval.plannerOutputTokens === undefined ? {} : { plannerOutputTokens: retrieval.plannerOutputTokens as number }),
      generatedQueryHashes: retrieval.generatedQueryHashes as string[],
      degraded: retrieval.degraded,
      ...(retrieval.degradedErrorClass === undefined ? {} : { degradedErrorClass: retrieval.degradedErrorClass as string }),
    },
    corpusVersion: value.corpusVersion,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}
