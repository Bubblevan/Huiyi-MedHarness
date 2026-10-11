import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { MemoryClientPort } from './client.js'
import { MemoryClientError } from './client.js'
import { emptyMemorySnapshot, type MemorySnapshot } from './contracts.js'
import type { MemoryTraceSink } from './trace.js'
import { renderMemorySnapshot } from './prompt.js'

interface ActiveTurn {
  sessionId: string
  turn: number
  startedAt?: number
  query?: string
  userMessages: Map<string, string>
  finalAssistantText?: string
  recallPromise?: Promise<MemorySnapshot>
  recallStartedAt?: number
  automaticRecallSkipRecorded?: boolean
}

function textContent(message: { content: readonly unknown[] }): string {
  return message.content.flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  }).join('\n').trim()
}

function errorClass(error: unknown): string {
  if (error instanceof MemoryClientError) return error.errorClass ?? error.kind
  return error instanceof Error ? error.name : 'UnknownError'
}

export type MemoryUserIdResolver = (agent: Agent) => string | undefined

export interface MemoryLifecycleOptions {
  /** Force AMA's dual-channel retrieval path for an evaluation profile. */
  automaticStrongRetrieve?: boolean
  /** Reuse the active DSH conversation after its initial per-Encounter recall. */
  automaticRecallFirstTurnOnly?: boolean
  /** Commit buffered patient turns at every Nth DSH turn in a synthetic evaluation. */
  commitBatchTurns?: number
  /** Disable post-turn writes while keeping automatic recall enabled. */
  readOnly?: boolean
  /** Render an evaluation-only context from the snapshot and current question. */
  renderContext?: (snapshot: MemorySnapshot, query: string) => string
}

export class MemoryLifecycle {
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly pendingCommits = new Set<Promise<void>>()
  private readonly subagentSessions = new Set<string>()
  private readonly bufferedPatientTurns = new Map<string, string[]>()
  private readonly sessionOwners = new Map<string, string>()
  private readonly lastCompletedTurns = new Map<string, number>()
  private readonly lastAssistantTexts = new Map<string, string>()
  private readonly endingSessions = new Map<string, Promise<void>>()
  private readonly endedSessions = new Set<string>()

  constructor(
    private readonly client: MemoryClientPort,
    private readonly trace: MemoryTraceSink,
    private readonly resolveUserId: MemoryUserIdResolver = () => process.env.HUIYI_MEMORY_USER_ID?.trim() || undefined,
    private readonly options: MemoryLifecycleOptions = {},
  ) {
    const batchTurns = options.commitBatchTurns ?? 1
    if (!Number.isSafeInteger(batchTurns) || batchTurns < 1 || batchTurns > 8) {
      throw new RangeError('commitBatchTurns must be an integer between 1 and 8')
    }
  }

  noteClaimed(agent: Agent, message: { source: { kind: string }; content: readonly unknown[] }, turn: number): void {
    if (this.subagentSessions.has(agent.id)) return
    const userId = this.resolveUserId(agent)
    this.sessionUsers.set(agent.id, userId)
    if (userId) this.sessionOwners.set(agent.id, userId)
    if (message.source.kind !== 'user') return
    const active = this.turns.get(agent.id)
    if (!active || active.turn !== turn) return
    active.query ??= textContent(message)
  }

  async recallOnce(agent: Agent, signal?: AbortSignal): Promise<MemorySnapshot | undefined> {
    if (this.subagentSessions.has(agent.id)) return undefined
    const active = this.turns.get(agent.id)
    if (!active || !active.query) return undefined
    if (active.recallPromise) return active.recallPromise
    if (this.options.automaticRecallFirstTurnOnly && active.turn > 1) {
      if (!active.automaticRecallSkipRecorded) {
        active.automaticRecallSkipRecorded = true
        this.trace.record({
          sessionId: active.sessionId,
          turn: active.turn,
          operation: 'automatic_recall',
          status: 'skipped',
          errorClass: 'encounter_context_already_active',
          time: Date.now(),
        })
      }
      return undefined
    }

    const userId = this.sessionUsers.has(agent.id)
      ? this.sessionUsers.get(agent.id)
      : this.resolveUserId(agent)
    if (!userId) {
      this.trace.record({
        sessionId: active.sessionId,
        turn: active.turn,
        operation: 'automatic_recall',
        status: 'skipped',
        errorClass: 'identity_unavailable',
        time: Date.now(),
      })
      active.recallPromise = Promise.resolve(freezeSnapshot(emptyMemorySnapshot('', active.sessionId, active.turn)))
      return active.recallPromise
    }

    active.recallStartedAt = performance.now()
    active.recallPromise = this.client.recall({
      userId,
      sessionId: active.sessionId,
      turn: active.turn,
      query: active.query,
      strong: this.options.automaticStrongRetrieve ?? false,
    }, { signal }).then(response => {
      const snapshot = freezeSnapshot(response)
      this.trace.record({
        sessionId: active.sessionId,
        turn: active.turn,
        operation: 'automatic_recall',
        status: 'completed',
        itemCount: snapshot.items.length,
        tokenEstimate: snapshot.tokenEstimate,
        latencyMs: elapsed(active.recallStartedAt),
        strongRetrieve: this.options.automaticStrongRetrieve ?? false,
        retrievalRounds: snapshot.retrievalRounds,
        refreshTriggered: snapshot.refreshTriggered,
        amaLlmCallCount: snapshot.amaLlmCallCount,
        amaPromptTokens: snapshot.amaPromptTokens,
        amaCompletionTokens: snapshot.amaCompletionTokens,
        amaUsageReportCount: snapshot.amaUsageReportCount,
        time: Date.now(),
      })
      return snapshot
    }).catch(error => {
      this.trace.record({
        sessionId: active.sessionId,
        turn: active.turn,
        operation: 'automatic_recall',
        status: 'failed',
        latencyMs: elapsed(active.recallStartedAt),
        errorClass: errorClass(error),
        time: Date.now(),
      })
      return freezeSnapshot(emptyMemorySnapshot(userId, active.sessionId, active.turn))
    })
    return active.recallPromise
  }

  observeSessionEvent(session: Session, event: SessionEvent): void {
    // `parentSession` also records ordinary fork ancestry. Only DSH's explicit
    // origin tag identifies a child that must not receive patient Memory.
    if (session.header?.origin === 'subagent') {
      this.subagentSessions.add(session.id)
      this.turns.delete(session.id)
      this.sessionUsers.delete(session.id)
      this.bufferedPatientTurns.delete(session.id)
      return
    }

    if (event.type === 'turn/start') {
      this.turns.set(session.id, {
        sessionId: session.id,
        turn: event.data.turn,
        startedAt: event.time,
        userMessages: new Map(),
      })
      return
    }

    const active = this.turns.get(session.id)
    if (!active) return

    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = textContent(event.data)
      if (text) active.userMessages.set(event.data.id, text)
      active.query ??= text || undefined
      return
    }

    if (event.type === 'assistant/message' && event.data.turn === active.turn) {
      if (event.data.interrupted !== true) {
        const text = textContent(event.data.message)
        if (text) active.finalAssistantText = text
      }
      return
    }

    if (event.type === 'turn/end' && event.data.turn === active.turn) {
      this.finishTurn(session.id, active, event)
    }
  }

  currentTurn(sessionId: string): number | undefined {
    return this.turns.get(sessionId)?.turn
  }

  queryForAgent(agentId: string): string {
    return this.turns.get(agentId)?.query ?? ''
  }

  userIdForAgent(agent: Agent): string | undefined {
    return this.resolveUserId(agent)
  }

  async manualRecall(agent: Agent, query: string, strong: boolean, signal?: AbortSignal): Promise<MemorySnapshot> {
    const sessionId = agent.id
    const turn = this.turns.get(sessionId)?.turn ?? 0
    const userId = this.resolveUserId(agent)
    if (!userId) throw new MemoryClientError('unavailable', 'Trusted memory identity is not configured')
    const startedAt = performance.now()
    try {
      const snapshot = freezeSnapshot(await this.client.recall({
        userId, sessionId, turn, query, strong,
      }, { signal }))
      this.trace.record({
        sessionId, turn, operation: 'manual_recall', status: 'completed',
        itemCount: snapshot.items.length, tokenEstimate: snapshot.tokenEstimate,
        latencyMs: elapsed(startedAt), strongRetrieve: strong,
        retrievalRounds: snapshot.retrievalRounds, refreshTriggered: snapshot.refreshTriggered,
        amaLlmCallCount: snapshot.amaLlmCallCount,
        amaPromptTokens: snapshot.amaPromptTokens,
        amaCompletionTokens: snapshot.amaCompletionTokens,
        amaUsageReportCount: snapshot.amaUsageReportCount,
        time: Date.now(),
      })
      return snapshot
    } catch (error) {
      this.trace.record({
        sessionId, turn, operation: 'manual_recall', status: 'failed',
        latencyMs: elapsed(startedAt), strongRetrieve: strong,
        errorClass: errorClass(error), time: Date.now(),
      })
      throw error
    }
  }

  clearAgent(agentId: string): void {
    this.turns.delete(agentId)
    this.sessionUsers.delete(agentId)
    this.subagentSessions.delete(agentId)
    this.bufferedPatientTurns.delete(agentId)
    this.sessionOwners.delete(agentId)
    this.lastCompletedTurns.delete(agentId)
    this.lastAssistantTexts.delete(agentId)
    this.endingSessions.delete(agentId)
    this.endedSessions.delete(agentId)
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingCommits])
  }

  /** Flush the final patient batch and ask AMA to finalize this Encounter before its Agent is disposed. */
  async endSession(sessionId: string): Promise<void> {
    if (this.endedSessions.has(sessionId)) return
    const pending = this.endingSessions.get(sessionId)
    if (pending) return pending
    const ending = this.finishSession(sessionId).finally(() => this.endingSessions.delete(sessionId))
    this.endingSessions.set(sessionId, ending)
    return ending
  }

  private async finishSession(sessionId: string): Promise<void> {
    const turn = this.lastCompletedTurns.get(sessionId)
    if (this.options.readOnly) {
      this.trace.record({ sessionId, ...(turn === undefined ? {} : { turn }), operation: 'session_end', status: 'skipped', errorClass: 'evaluation_read_only', time: Date.now() })
      this.endedSessions.add(sessionId)
      return
    }

    const userId = this.sessionOwners.get(sessionId)
    if (!userId) {
      this.trace.record({ sessionId, ...(turn === undefined ? {} : { turn }), operation: 'session_end', status: 'skipped', errorClass: 'identity_unavailable', time: Date.now() })
      this.endedSessions.add(sessionId)
      return
    }

    await this.flush()
    const buffered = this.bufferedPatientTurns.get(sessionId) ?? []
    if (buffered.length > 0) {
      const assistantText = this.lastAssistantTexts.get(sessionId)
      if (turn === undefined || !assistantText) {
        this.trace.record({ sessionId, ...(turn === undefined ? {} : { turn }), operation: 'commit', status: 'failed', commitStatus: 'failed', errorClass: 'incomplete_session_batch', time: Date.now() })
        return
      }
      const startedAt = performance.now()
      try {
        const result = await this.client.commitTurn({
          idempotencyKey: `${sessionId}:${turn}`,
          userId,
          sessionId,
          turn,
          userText: buffered.join('\n\n'),
          assistantText,
        })
        this.trace.record({
          sessionId, turn, operation: 'commit',
          status: result.status === 'duplicate' ? 'duplicate' : result.status === 'committed' ? 'completed' : result.status === 'failed' ? 'failed' : 'in_progress',
          commitStatus: result.status,
          latencyMs: elapsed(startedAt),
          amaLlmCallCount: result.amaLlmCallCount,
          amaPromptTokens: result.amaPromptTokens,
          amaCompletionTokens: result.amaCompletionTokens,
          amaUsageReportCount: result.amaUsageReportCount,
          refreshTriggered: result.refreshTriggered,
          episodeGenerated: result.episodeGenerated,
          time: Date.now(),
        })
        if (result.status !== 'committed' && result.status !== 'duplicate') return
        this.bufferedPatientTurns.delete(sessionId)
      } catch (error) {
        this.trace.record({ sessionId, turn, operation: 'commit', status: 'failed', commitStatus: 'failed', latencyMs: elapsed(startedAt), errorClass: errorClass(error), time: Date.now() })
        return
      }
    }

    if (turn === undefined) {
      this.trace.record({ sessionId, operation: 'session_end', status: 'skipped', errorClass: 'no_completed_patient_turn', time: Date.now() })
      this.endedSessions.add(sessionId)
      return
    }

    const startedAt = performance.now()
    try {
      const result = await this.client.sessionEnd({ userId, sessionId })
      this.trace.record({
        sessionId, turn, operation: 'session_end',
        status: result.status === 'completed' ? 'completed' : result.status === 'duplicate' ? 'duplicate' : result.status === 'skipped' ? 'skipped' : result.status === 'in_progress' ? 'in_progress' : 'failed',
        latencyMs: elapsed(startedAt),
        amaLlmCallCount: result.amaLlmCallCount,
        amaPromptTokens: result.amaPromptTokens,
        amaCompletionTokens: result.amaCompletionTokens,
        amaUsageReportCount: result.amaUsageReportCount,
        episodeGenerated: result.episodeGenerated,
        ...(result.status === 'failed' ? { errorClass: 'memory_session_end_failed' } : {}),
        time: Date.now(),
      })
      if (result.status === 'completed' || result.status === 'duplicate' || result.status === 'skipped') this.endedSessions.add(sessionId)
    } catch (error) {
      this.trace.record({ sessionId, turn, operation: 'session_end', status: 'failed', latencyMs: elapsed(startedAt), errorClass: errorClass(error), time: Date.now() })
    }
  }

  private finishTurn(sessionId: string, active: ActiveTurn, event: SessionEvent<'turn/end'>): void {
    const reason = event.data.reason.kind
    const userText = [...active.userMessages.values()].join('\n\n')
    const assistantText = active.finalAssistantText
    const userId = this.resolveUserIdForSession(sessionId)
    const latencyMs = active.startedAt === undefined ? undefined : Math.max(0, event.time - active.startedAt)

    if (reason !== 'completed' || !userId || !userText || !assistantText) {
      this.trace.record({
        sessionId,
        turn: active.turn,
        operation: 'commit',
        status: 'skipped',
        commitStatus: 'failed',
        totalDshTurnLatencyMs: latencyMs,
        errorClass: reason !== 'completed' ? `turn_${reason}` : !userId ? 'identity_unavailable' : 'final_pair_unavailable',
        time: Date.now(),
      })
      this.turns.delete(sessionId)
      this.sessionUsers.delete(sessionId)
      return
    }

    this.lastCompletedTurns.set(sessionId, active.turn)
    this.lastAssistantTexts.set(sessionId, assistantText)

    if (this.options.readOnly) {
      this.trace.record({
        sessionId,
        turn: active.turn,
        operation: 'commit',
        status: 'skipped',
        totalDshTurnLatencyMs: latencyMs,
        errorClass: 'evaluation_read_only',
        time: Date.now(),
      })
      this.turns.delete(sessionId)
      this.sessionUsers.delete(sessionId)
      return
    }

    const batchTurns = this.options.commitBatchTurns ?? 1
    const buffered = this.bufferedPatientTurns.get(sessionId) ?? []
    const batch = [...buffered, userText]
    if (active.turn % batchTurns !== 0) {
      this.bufferedPatientTurns.set(sessionId, batch)
      this.trace.record({
        sessionId,
        turn: active.turn,
        operation: 'commit',
        status: 'skipped',
        totalDshTurnLatencyMs: latencyMs,
        errorClass: 'encounter_batch_pending',
        time: Date.now(),
      })
      this.turns.delete(sessionId)
      this.sessionUsers.delete(sessionId)
      return
    }

    this.bufferedPatientTurns.delete(sessionId)
    const idempotencyKey = `${sessionId}:${active.turn}`
    const startedAt = performance.now()
    const commit = this.client.commitTurn({
      idempotencyKey,
      userId,
      sessionId,
      turn: active.turn,
      userText: batch.join('\n\n'),
      assistantText,
    }).then(result => {
      this.trace.record({
        sessionId,
        turn: active.turn,
        operation: 'commit',
        status: result.status === 'duplicate' ? 'duplicate' : result.status === 'committed' ? 'completed' : result.status === 'failed' ? 'failed' : 'in_progress',
        commitStatus: result.status,
        latencyMs: elapsed(startedAt),
        amaLlmCallCount: result.amaLlmCallCount,
        amaPromptTokens: result.amaPromptTokens,
        amaCompletionTokens: result.amaCompletionTokens,
        amaUsageReportCount: result.amaUsageReportCount,
        refreshTriggered: result.refreshTriggered,
        episodeGenerated: result.episodeGenerated,
        totalDshTurnLatencyMs: latencyMs,
        time: Date.now(),
      })
    }).catch(error => {
      this.trace.record({
        sessionId,
        turn: active.turn,
        operation: 'commit',
        status: 'failed',
        commitStatus: 'failed',
        latencyMs: elapsed(startedAt),
        totalDshTurnLatencyMs: latencyMs,
        errorClass: errorClass(error),
        time: Date.now(),
      })
    }).finally(() => {
      this.pendingCommits.delete(commit)
    })
    this.pendingCommits.add(commit)
    this.turns.delete(sessionId)
    this.sessionUsers.delete(sessionId)
  }

  private resolveUserIdForSession(sessionId: string): string | undefined {
    // The DSH event callback has no Agent argument. Keep the trusted resolver's
    // value captured per session rather than resolving from model-visible text.
    return this.sessionUsers.get(sessionId)
  }

  private readonly sessionUsers = new Map<string, string | undefined>()
}

function freezeSnapshot(snapshot: MemorySnapshot): MemorySnapshot {
  const items = Object.freeze(snapshot.items.map(item => Object.freeze({ ...item })))
  return Object.freeze({ ...snapshot, items })
}

function elapsed(startedAt: number | undefined): number | undefined {
  return startedAt === undefined ? undefined : Math.max(0, performance.now() - startedAt)
}

export function installMemoryLifecycle(
  ctx: Context,
  client: MemoryClientPort,
  trace: MemoryTraceSink,
  resolveUserId?: MemoryUserIdResolver,
  options: MemoryLifecycleOptions = {},
): MemoryLifecycle {
  const lifecycle = new MemoryLifecycle(client, trace, resolveUserId, options)

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    lifecycle.noteClaimed(agent, message, turn)
  })

  ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
    const base = await next()
    const agent = assembleContext.agent
    if (!agent) return base

    const snapshot = await lifecycle.recallOnce(agent, assembleContext.signal)
    if (!snapshot || (snapshot.items.length === 0 && !options.renderContext)) return base
    const text = options.renderContext
      ? options.renderContext(snapshot, lifecycle.queryForAgent(agent.id))
      : renderMemorySnapshot(snapshot)
    if (!text) return base
    const memoryContext = {
      name: 'huiyi:patient-memory',
      text,
    }
    return {
      ...base,
      contexts: [...base.contexts.filter(context => context.name !== memoryContext.name), memoryContext],
    }
  })

  ctx.on('session/event', (session, event) => lifecycle.observeSessionEvent(session, event))
  ctx.on('agent/disposed', ({ agent }) => {
    lifecycle.clearAgent(agent.id)
  })
  ctx.effect(() => () => lifecycle.flush(), 'huiyi-memory.pending-commits')

  return lifecycle
}
