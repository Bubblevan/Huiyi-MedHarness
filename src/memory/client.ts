import type {
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryRecallRequest,
  MemorySessionEndRequest,
  MemorySessionEndResult,
  MemorySnapshot,
  MemoryStats,
} from './contracts.js'

export type MemoryErrorKind = 'timeout' | 'aborted' | 'unavailable' | 'conflict' | 'invalid_request' | 'backend'

export class MemoryClientError extends Error {
  constructor(
    readonly kind: MemoryErrorKind,
    message: string,
    readonly status?: number,
    readonly errorClass?: string,
  ) {
    super(message)
    this.name = 'MemoryClientError'
  }
}

export interface RequestOptions {
  signal?: AbortSignal
}

export interface MemoryClientPort {
  recall(request: MemoryRecallRequest, options?: RequestOptions): Promise<MemorySnapshot>
  commitTurn(request: MemoryCommitRequest, options?: RequestOptions): Promise<MemoryCommitResult>
  sessionEnd(request: MemorySessionEndRequest, options?: RequestOptions): Promise<MemorySessionEndResult>
  stats(userId: string, options?: RequestOptions): Promise<MemoryStats>
  forget(request: MemoryForgetRequest, options?: RequestOptions): Promise<MemoryForgetResult>
  health(options?: RequestOptions): Promise<{ status: 'ok' }>
}

export class MemoryClient implements MemoryClientPort {
  private readonly baseUrl: string
  private readonly timeouts: Record<'recall' | 'commit' | 'sessionEnd' | 'small', number>

  constructor(options: {
    baseUrl?: string
    timeoutMs?: number
    recallTimeoutMs?: number
    commitTimeoutMs?: number
    sessionEndTimeoutMs?: number
    smallTimeoutMs?: number
  } = {}) {
    const configuredUrl = new URL(options.baseUrl ?? process.env.HUIYI_HEALTH_ENGINE_URL ?? 'http://127.0.0.1:8322')
    if (configuredUrl.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(configuredUrl.hostname)
      || configuredUrl.username !== '' || configuredUrl.password !== ''
      || !['', '/'].includes(configuredUrl.pathname)
      || configuredUrl.search !== '' || configuredUrl.hash !== '') {
      throw new TypeError('Health-engine URL must be a loopback HTTP origin')
    }
    this.baseUrl = configuredUrl.origin
    const fallback = boundedTimeout(options.timeoutMs, process.env.HUIYI_MEMORY_TIMEOUT_MS, 30000)
    this.timeouts = {
      recall: boundedTimeout(options.recallTimeoutMs, process.env.HUIYI_MEMORY_RECALL_TIMEOUT_MS, Math.max(fallback, 90000)),
      commit: boundedTimeout(options.commitTimeoutMs, process.env.HUIYI_MEMORY_COMMIT_TIMEOUT_MS, Math.max(fallback, 300000)),
      sessionEnd: boundedTimeout(options.sessionEndTimeoutMs, process.env.HUIYI_MEMORY_SESSION_END_TIMEOUT_MS, Math.max(fallback, 300000)),
      small: boundedTimeout(options.smallTimeoutMs, process.env.HUIYI_MEMORY_SMALL_TIMEOUT_MS, Math.min(fallback, 10000)),
    }
  }

  recall(request: MemoryRecallRequest, options?: RequestOptions): Promise<MemorySnapshot> {
    return this.request('/v1/memory/recall', request, options, decodeSnapshot, this.timeouts.recall)
  }

  commitTurn(request: MemoryCommitRequest, options?: RequestOptions): Promise<MemoryCommitResult> {
    return this.request('/v1/memory/commit-turn', request, options, decodeCommitResult, this.timeouts.commit)
  }

  sessionEnd(request: MemorySessionEndRequest, options?: RequestOptions): Promise<MemorySessionEndResult> {
    return this.request('/v1/memory/session-end', request, options, decodeSessionEndResult, this.timeouts.sessionEnd)
  }

  stats(userId: string, options?: RequestOptions): Promise<MemoryStats> {
    return this.request(`/v1/memory/stats/${encodeURIComponent(userId)}`, undefined, options, decodeStats, this.timeouts.small)
  }

  forget(request: MemoryForgetRequest, options?: RequestOptions): Promise<MemoryForgetResult> {
    return this.request('/v1/memory/forget', request, options, decodeForgetResult, this.timeouts.commit)
  }

  health(options?: RequestOptions): Promise<{ status: 'ok' }> {
    return this.request('/health', undefined, options, value => {
      const result = object(value)
      if (result.status !== 'ok') throw new TypeError('invalid health response')
      return { status: 'ok' }
    }, this.timeouts.small)
  }

  private async request<T>(path: string, body: unknown | undefined, options: RequestOptions | undefined, decode: (value: unknown) => T, timeoutMs: number): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      if (options?.signal?.aborted) throw new MemoryClientError('aborted', 'Memory request was cancelled')
      if (signal.aborted) throw new MemoryClientError('timeout', 'Memory request timed out')
      const name = error instanceof Error ? error.name : 'UnknownError'
      throw new MemoryClientError('unavailable', `Health-engine request failed (${name})`)
    }

    if (!response.ok) {
      const kind: MemoryErrorKind = response.status === 409
        ? 'conflict'
        : response.status === 400 || response.status === 422
          ? 'invalid_request'
          : response.status === 408 || response.status === 504
            ? 'timeout'
            : response.status >= 500
              ? 'backend'
              : 'unavailable'
      const errorClass = await readErrorClass(response)
      throw new MemoryClientError(kind, `Health-engine returned HTTP ${response.status}`, response.status, errorClass)
    }

    try {
      return decode(await response.json() as unknown)
    } catch {
      throw new MemoryClientError('backend', 'Health-engine returned an invalid JSON response', response.status)
    }
  }
}

async function readErrorClass(response: Response): Promise<string | undefined> {
  try {
    const value = object(await response.json() as unknown)
    const detail = object(value.detail)
    return typeof detail.errorClass === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(detail.errorClass)
      ? detail.errorClass
      : undefined
  } catch {
    return undefined
  }
}

function boundedTimeout(explicit: number | undefined, environment: string | undefined, fallback: number): number {
  const candidate = explicit ?? (environment === undefined ? fallback : Number(environment))
  if (!Number.isFinite(candidate)) return fallback
  return Math.min(600000, Math.max(1, Math.floor(candidate)))
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected object')
  return value as Record<string, unknown>
}

function string(value: unknown): value is string {
  return typeof value === 'string'
}

function optionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || string(value)
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function decodeSnapshot(value: unknown): MemorySnapshot {
  const row = object(value)
  if (!string(row.snapshotId) || !string(row.userId) || !string(row.sessionId)
    || !Number.isInteger(row.turn) || !Array.isArray(row.items)
    || !optionalNumber(row.tokenEstimate) || !optionalNumber(row.retrievalRounds)
    || !optionalNumber(row.amaLlmCallCount)
    || !optionalNumber(row.amaPromptTokens) || !optionalNumber(row.amaCompletionTokens)
    || !optionalNumber(row.amaUsageReportCount)
    || (row.refreshTriggered !== undefined && typeof row.refreshTriggered !== 'boolean')) {
    throw new TypeError('invalid snapshot')
  }
  const items = row.items.map(item => {
    const entry = object(item)
    if (!['raw', 'fact', 'episode'].includes(String(entry.kind)) || !string(entry.content)
      || !optionalStringOrNull(entry.timestamp)
      || !optionalStringOrNull(entry.source)
      || !optionalStringOrNull(entry.sourceId)) throw new TypeError('invalid memory item')
    return {
      kind: entry.kind as 'raw' | 'fact' | 'episode',
      content: entry.content,
      ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
      ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
      ...(typeof entry.sourceId === 'string' ? { sourceId: entry.sourceId } : {}),
    }
  })
  return {
    snapshotId: row.snapshotId,
    userId: row.userId,
    sessionId: row.sessionId,
    turn: row.turn as number,
    items,
    ...(row.tokenEstimate === undefined ? {} : { tokenEstimate: row.tokenEstimate as number }),
    ...(row.retrievalRounds === undefined ? {} : { retrievalRounds: row.retrievalRounds as number }),
    ...(row.refreshTriggered === undefined ? {} : { refreshTriggered: row.refreshTriggered as boolean }),
    ...(row.amaLlmCallCount === undefined ? {} : { amaLlmCallCount: row.amaLlmCallCount as number }),
    ...(row.amaPromptTokens === undefined ? {} : { amaPromptTokens: row.amaPromptTokens as number }),
    ...(row.amaCompletionTokens === undefined ? {} : { amaCompletionTokens: row.amaCompletionTokens as number }),
    ...(row.amaUsageReportCount === undefined ? {} : { amaUsageReportCount: row.amaUsageReportCount as number }),
  }
}

function decodeCommitResult(value: unknown): MemoryCommitResult {
  const row = object(value)
  if (!['committed', 'duplicate', 'in_progress', 'failed'].includes(String(row.status))
    || typeof row.duplicate !== 'boolean') throw new TypeError('invalid commit result')
  return row as unknown as MemoryCommitResult
}

function decodeSessionEndResult(value: unknown): MemorySessionEndResult {
  const row = object(value)
  if (!['completed', 'duplicate', 'in_progress', 'skipped', 'failed'].includes(String(row.status))
    || typeof row.duplicate !== 'boolean') throw new TypeError('invalid session-end result')
  return row as unknown as MemorySessionEndResult
}

function decodeStats(value: unknown): MemoryStats {
  const row = object(value)
  const records = object(row.records)
  if (!string(row.userId) || !Number.isInteger(row.memoryWindowItems)
    || !Number.isInteger(records.raw) || !Number.isInteger(records.facts)
    || !Number.isInteger(records.episodes)) throw new TypeError('invalid stats result')
  return {
    userId: row.userId,
    memoryWindowItems: row.memoryWindowItems as number,
    records: { raw: records.raw as number, facts: records.facts as number, episodes: records.episodes as number },
  }
}

function decodeForgetResult(value: unknown): MemoryForgetResult {
  const row = object(value)
  if (row.status !== 'forgotten' || !Number.isInteger(row.recordsRemoved)) throw new TypeError('invalid forget result')
  return { status: 'forgotten', recordsRemoved: row.recordsRemoved as number }
}
