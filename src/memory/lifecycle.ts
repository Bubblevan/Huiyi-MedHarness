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

export class MemoryLifecycle {
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly pendingCommits = new Set<Promise<void>>()

  constructor(
    private readonly client: MemoryClientPort,
    private readonly trace: MemoryTraceSink,
    private readonly resolveUserId: MemoryUserIdResolver = () => process.env.HUIYI_MEMORY_USER_ID?.trim() || undefined,
  ) {}

  noteClaimed(agent: Agent, message: { source: { kind: string }; content: readonly unknown[] }, turn: number): void {
    this.sessionUsers.set(agent.id, this.resolveUserId(agent))
    if (message.source.kind !== 'user') return
    const active = this.turns.get(agent.id)
    if (!active || active.turn !== turn) return
    active.query ??= textContent(message)
  }

  async recallOnce(agent: Agent, signal?: AbortSignal): Promise<MemorySnapshot | undefined> {
    const active = this.turns.get(agent.id)
    if (!active || !active.query) return undefined
    if (active.recallPromise) return active.recallPromise

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
        strongRetrieve: false,
        retrievalRounds: snapshot.retrievalRounds,
        refreshTriggered: snapshot.refreshTriggered,
        amaLlmCallCount: snapshot.amaLlmCallCount,
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
        amaLlmCallCount: snapshot.amaLlmCallCount, time: Date.now(),
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
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingCommits])
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

    const idempotencyKey = `${sessionId}:${active.turn}`
    const startedAt = performance.now()
    const commit = this.client.commitTurn({
      idempotencyKey,
      userId,
      sessionId,
      turn: active.turn,
      userText,
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
): MemoryLifecycle {
  const lifecycle = new MemoryLifecycle(client, trace, resolveUserId)

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    lifecycle.noteClaimed(agent, message, turn)
  })

  ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
    const base = await next()
    const agent = assembleContext.agent
    if (!agent) return base

    const snapshot = await lifecycle.recallOnce(agent, assembleContext.signal)
    if (!snapshot || snapshot.items.length === 0) return base
    const memoryContext = {
      name: 'huiyi:patient-memory',
      text: renderMemorySnapshot(snapshot),
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
