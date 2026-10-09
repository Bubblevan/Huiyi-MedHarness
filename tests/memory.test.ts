import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MemoryClient, MemoryClientError, type MemoryClientPort } from '../src/memory/client.js'
import type {
  MemoryKind,
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryRecallRequest,
  MemorySessionEndRequest,
  MemorySessionEndResult,
  MemoryStats,
  MemorySnapshot,
  MemoryTraceRecord,
} from '../src/memory/contracts.js'
import { MemoryLifecycle } from '../src/memory/lifecycle.js'
import { renderMemorySnapshot } from '../src/memory/prompt.js'
import { applyMemoryOnly } from '../src/index.js'
import memoryContracts from '../fixtures/memory-contracts.json' with { type: 'json' }

describe('cross-language HTTP contract fixture', () => {
  it('matches all TypeScript request and response types', () => {
    const recallRequest = memoryContracts.recallRequest satisfies MemoryRecallRequest
    const snapshot = {
      ...memoryContracts.snapshot,
      items: memoryContracts.snapshot.items.map(item => ({ ...item, kind: item.kind as MemoryKind })),
    } satisfies MemorySnapshot
    const commitRequest = memoryContracts.commitRequest satisfies MemoryCommitRequest
    const commitResult = { ...memoryContracts.commitResult, status: memoryContracts.commitResult.status as 'committed' } satisfies MemoryCommitResult
    const sessionEndRequest = memoryContracts.sessionEndRequest satisfies MemorySessionEndRequest
    const sessionEndResult = { ...memoryContracts.sessionEndResult, status: memoryContracts.sessionEndResult.status as 'skipped' } satisfies MemorySessionEndResult
    const stats = memoryContracts.stats satisfies MemoryStats
    const forgetRequest = { ...memoryContracts.forgetRequest, confirmation: memoryContracts.forgetRequest.confirmation as 'forget all patient memory' } satisfies MemoryForgetRequest
    const forgetResult = { ...memoryContracts.forgetResult, status: memoryContracts.forgetResult.status as 'forgotten' } satisfies MemoryForgetResult
    expect([recallRequest, snapshot, commitRequest, commitResult, sessionEndRequest, sessionEndResult, stats, forgetRequest, forgetResult]).toHaveLength(9)
  })
})

describe('patient memory prompt context', () => {
  it('escapes recalled text and labels it as historical context, not evidence', () => {
    const snapshot: MemorySnapshot = {
      snapshotId: 'opaque-snapshot',
      userId: 'synthetic-patient',
      sessionId: 'session-1',
      turn: 2,
      items: [{ kind: 'fact', content: '<PRIVATE_HISTORY> & prior claim' }],
    }
    const rendered = renderMemorySnapshot(snapshot)
    expect(rendered).toContain('contextual claims from prior user or patient interactions')
    expect(rendered).toContain('&lt;PRIVATE_HISTORY&gt; &amp; prior claim')
    expect(rendered).not.toContain('opaque-snapshot')
    expect(rendered).not.toContain('<PRIVATE_HISTORY>')
  })
})

describe('health-engine HTTP client', () => {
  it('maps a valid recall response to the typed snapshot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      snapshotId: 'snap-1', userId: 'u1', sessionId: 's1', turn: 1, items: [], tokenEstimate: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = new MemoryClient({ baseUrl: 'http://127.0.0.1:8322' })
    await expect(client.recall({ userId: 'u1', sessionId: 's1', turn: 1, query: 'history' }))
      .resolves.toMatchObject({ snapshotId: 'snap-1', items: [] })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8322/v1/memory/recall', expect.objectContaining({ method: 'POST' }))
    fetchMock.mockRestore()
  })

  it('rejects malformed success payloads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"items":"not-an-array"}', { status: 200 }))
    const client = new MemoryClient()
    await expect(client.recall({ userId: 'u1', sessionId: 's1', turn: 1, query: 'history' }))
      .rejects.toMatchObject({ kind: 'backend' } satisfies Partial<MemoryClientError>)
    fetchMock.mockRestore()
  })

  it('retains only a sanitized backend exception class in diagnostics', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ detail: { error: 'backend', errorClass: 'IndexError' } }),
      { status: 503 },
    ))
    const client = new MemoryClient()
    await expect(client.recall({ userId: 'u1', sessionId: 's1', turn: 1, query: 'history' }))
      .rejects.toMatchObject({ kind: 'backend', errorClass: 'IndexError' } satisfies Partial<MemoryClientError>)
    fetchMock.mockRestore()
  })

  it('normalizes Pydantic nulls for optional memory item fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      snapshotId: 'snap-1', userId: 'u1', sessionId: 's1', turn: 1,
      items: [{ kind: 'fact', content: 'test-only', timestamp: null, source: null, sourceId: 'D1:2' }],
      tokenEstimate: 1, retrievalRounds: 1,
    }), { status: 200 }))
    const client = new MemoryClient()
    await expect(client.recall({ userId: 'u1', sessionId: 's1', turn: 1, query: 'history' }))
      .resolves.toMatchObject({ items: [{ kind: 'fact', content: 'test-only', sourceId: 'D1:2' }] })
    fetchMock.mockRestore()
  })

  it('maps cancellation and HTTP conflicts to explicit error classes', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'))
    const client = new MemoryClient({ timeoutMs: 5000 })
    await expect(client.health({ signal: aborted.signal })).rejects.toMatchObject({ kind: 'aborted' })
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }))
    await expect(client.commitTurn({
      idempotencyKey: 's1:1', userId: 'u1', sessionId: 's1', turn: 1, userText: 'u', assistantText: 'a',
    })).rejects.toMatchObject({ kind: 'conflict', status: 409 })
    fetchMock.mockRestore()
  })

  it('rejects a non-loopback health-engine URL', () => {
    expect(() => new MemoryClient({ baseUrl: 'https://memory.example/v1' })).toThrow(/loopback HTTP origin/)
  })
})

describe('DSH turn-scoped memory lifecycle', () => {
  it('mounts the memory-only benchmark composition without registering tools or RAG hooks', () => {
    const eventNames: string[] = []
    const toolRegister = vi.fn()
    const context = {
      on: (name: string) => { eventNames.push(name) },
      effect: () => undefined,
      tools: { register: toolRegister },
    } as unknown as Context

    applyMemoryOnly(context, () => 'locomo-user', { automaticStrongRetrieve: true, readOnly: true }, {
      client: {} as MemoryClientPort,
      trace: { record: () => undefined },
    })

    expect(eventNames).toEqual(['agent/inbox/claimed', 'system-prompt/assemble', 'session/event', 'agent/disposed'])
    expect(toolRegister).not.toHaveBeenCalled()
  })

  it('reuses one snapshot across model steps and commits one completed root pair', async () => {
    const snapshot: MemorySnapshot = {
      snapshotId: 'snap-1', userId: 'patient-1', sessionId: 'session-1', turn: 1,
      items: [{ kind: 'fact', content: 'test-only history' }],
    }
    const client: MemoryClientPort = {
      recall: vi.fn(async () => snapshot),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async (userId: string) => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const records: MemoryTraceRecord[] = []
    const lifecycle = new MemoryLifecycle(client, { record: record => records.push(record) }, () => 'patient-1')
    const session = { id: 'session-1' } as Session
    const agent = { id: 'session-1' } as Agent
    lifecycle.observeSessionEvent(session, event('turn/start', { turn: 1 }, 1))
    lifecycle.noteClaimed(agent, { source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic test history' }] }, 1)

    const first = await lifecycle.recallOnce(agent)
    const second = await lifecycle.recallOnce(agent)
    expect(first).toEqual(snapshot)
    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first?.items)).toBe(true)
    expect(client.recall).toHaveBeenCalledTimes(1)

    lifecycle.observeSessionEvent(session, event('user/message', {
      id: 'user-1', role: 'user', content: [{ type: 'text', text: 'synthetic test history' }], source: { kind: 'user' },
    }, 2))
    lifecycle.observeSessionEvent(session, event('assistant/message', {
      turn: 1, step: 2, interrupted: false, message: { content: [{ type: 'text', text: 'synthetic reply' }] }, stream: [],
    }, 3))
    lifecycle.observeSessionEvent(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
    await lifecycle.flush()

    expect(client.commitTurn).toHaveBeenCalledTimes(1)
    expect(client.commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'session-1:1', userText: 'synthetic test history', assistantText: 'synthetic reply',
    }))
    expect(records.map(record => record.operation)).toEqual(['automatic_recall', 'commit'])
    expect(JSON.stringify(records)).not.toContain('synthetic test history')
    expect(JSON.stringify(records)).not.toContain('synthetic reply')
  })

  it('does not recall or commit Memory for a DSH subagent session', async () => {
    const client: MemoryClientPort = {
      recall: vi.fn(async (): Promise<MemorySnapshot> => ({ snapshotId: 'should-not-exist', userId: 'patient-1', sessionId: 'child-1', turn: 1, items: [] })),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async (userId: string) => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const records: MemoryTraceRecord[] = []
    const lifecycle = new MemoryLifecycle(client, { record: record => records.push(record) }, () => 'patient-1')
    const session = {
      id: 'child-1',
      header: { id: 'child-1', version: 4, createdAt: 1, isSeeded: false, origin: 'subagent', parentSession: 'root-1' },
    } as unknown as Session
    const agent = { id: 'child-1' } as Agent

    lifecycle.observeSessionEvent(session, event('turn/start', { turn: 1 }, 1))
    lifecycle.noteClaimed(agent, { source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic child task' }] }, 1)
    lifecycle.observeSessionEvent(session, event('user/message', {
      id: 'child-user', role: 'user', content: [{ type: 'text', text: 'synthetic child task' }], source: { kind: 'user' },
    }, 2))
    lifecycle.observeSessionEvent(session, event('assistant/message', {
      turn: 1, step: 1, interrupted: false, message: { content: [{ type: 'text', text: 'synthetic child result' }] }, stream: [],
    }, 3))
    lifecycle.observeSessionEvent(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))

    await expect(lifecycle.recallOnce(agent)).resolves.toBeUndefined()
    await lifecycle.flush()
    expect(client.recall).not.toHaveBeenCalled()
    expect(client.commitTurn).not.toHaveBeenCalled()
    expect(records).toEqual([])
  })

  it('keeps Memory enabled for a normal root session with fork ancestry', async () => {
    const snapshot: MemorySnapshot = { snapshotId: 'fork-snapshot', userId: 'patient-1', sessionId: 'fork-root', turn: 1, items: [] }
    const client: MemoryClientPort = {
      recall: vi.fn(async () => snapshot),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async (userId: string) => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const lifecycle = new MemoryLifecycle(client, { record: () => undefined }, () => 'patient-1')
    const session = {
      id: 'fork-root',
      header: { id: 'fork-root', version: 4, createdAt: 1, isSeeded: true, parentSession: 'prior-session' },
    } as unknown as Session
    const agent = { id: 'fork-root' } as Agent

    lifecycle.observeSessionEvent(session, event('turn/start', { turn: 1 }, 1))
    lifecycle.noteClaimed(agent, { source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic forked query' }] }, 1)
    await expect(lifecycle.recallOnce(agent)).resolves.toMatchObject(snapshot)
    expect(client.recall).toHaveBeenCalledTimes(1)
  })

  it('supports read-only LoCoMo recall with strong retrieval and no post-turn commit', async () => {
    const snapshot: MemorySnapshot = {
      snapshotId: 'locomo-snapshot', userId: 'locomo-user', sessionId: 'locomo-session', turn: 1,
      items: [{ kind: 'raw', content: 'Earlier conversation item\ntimestamp:2023-05-08' }],
    }
    const client: MemoryClientPort = {
      recall: vi.fn(async () => snapshot),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async (userId: string) => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const records: MemoryTraceRecord[] = []
    const lifecycle = new MemoryLifecycle(
      client,
      { record: record => records.push(record) },
      () => 'locomo-user',
      { automaticStrongRetrieve: true, readOnly: true },
    )
    const session = { id: 'locomo-session' } as Session
    const agent = { id: 'locomo-session' } as Agent
    lifecycle.observeSessionEvent(session, event('turn/start', { turn: 1 }, 1))
    lifecycle.noteClaimed(agent, { source: { kind: 'user' }, content: [{ type: 'text', text: 'What happened before?' }] }, 1)

    await lifecycle.recallOnce(agent)
    lifecycle.observeSessionEvent(session, event('user/message', {
      id: 'locomo-user-1', role: 'user', content: [{ type: 'text', text: 'What happened before?' }], source: { kind: 'user' },
    }, 2))
    lifecycle.observeSessionEvent(session, event('assistant/message', {
      turn: 1, step: 1, interrupted: false, message: { content: [{ type: 'text', text: '{"answer":"something"}' }] }, stream: [],
    }, 3))
    lifecycle.observeSessionEvent(session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))
    await lifecycle.flush()

    expect(client.recall).toHaveBeenCalledTimes(1)
    expect(client.recall).toHaveBeenCalledWith(expect.objectContaining({ strong: true }), expect.anything())
    expect(client.commitTurn).not.toHaveBeenCalled()
    expect(records).toContainEqual(expect.objectContaining({ operation: 'commit', status: 'skipped', errorClass: 'evaluation_read_only' }))
  })

  it.each(['error', 'aborted', 'max-tokens'] as const)('does not capture a %s turn', async (reason: 'error' | 'aborted' | 'max-tokens') => {
    const client: MemoryClientPort = {
      recall: vi.fn(async (_request: unknown): Promise<MemorySnapshot> => ({ snapshotId: 's', userId: 'u', sessionId: 'x', turn: 1, items: [] })),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async (userId: string) => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const lifecycle = new MemoryLifecycle(client, { record: () => undefined }, () => 'patient-1')
    const session = { id: 'session-1' } as Session
    lifecycle.observeSessionEvent(session, event('turn/start', { turn: 1 }, 1))
    lifecycle.observeSessionEvent(session, event('user/message', {
      id: 'user-1', role: 'user', content: [{ type: 'text', text: 'private test' }], source: { kind: 'user' },
    }, 2))
    lifecycle.observeSessionEvent(session, event('assistant/message', {
      turn: 1, step: 1, interrupted: false, message: { content: [{ type: 'text', text: 'partial answer' }] }, stream: [],
    }, 3))
    lifecycle.observeSessionEvent(session, event('turn/end', { turn: 1, reason: { kind: reason } }, 4))
    await lifecycle.flush()
    expect(client.commitTurn).not.toHaveBeenCalled()
  })

  it('fails open with an empty snapshot when automatic recall is unavailable', async () => {
    const client: MemoryClientPort = {
      recall: vi.fn(async () => { throw new MemoryClientError('unavailable', 'service is down') }),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async (userId: string) => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const records: MemoryTraceRecord[] = []
    const lifecycle = new MemoryLifecycle(client, { record: record => records.push(record) }, () => 'patient-1')
    const session = { id: 'session-1' } as Session
    const agent = { id: 'session-1' } as Agent
    lifecycle.observeSessionEvent(session, event('turn/start', { turn: 1 }, 1))
    lifecycle.noteClaimed(agent, { source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic query' }] }, 1)

    const snapshot = await lifecycle.recallOnce(agent)
    expect(snapshot?.items).toEqual([])
    expect(renderMemorySnapshot(snapshot!)).toBe('')
    expect(records).toMatchObject([{ operation: 'automatic_recall', status: 'failed', errorClass: 'unavailable' }])
  })
})

function event(type: string, data: unknown, time: number): SessionEvent {
  return { type, data, seq: time, time } as unknown as SessionEvent
}
