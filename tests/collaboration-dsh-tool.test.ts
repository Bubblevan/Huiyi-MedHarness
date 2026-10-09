import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { installCollaborationWhenSpawnAvailable, installDshCollaborationTool } from '../src/collaboration/dsh-tool.js'
import type { DshCollaborationContext } from '../src/collaboration/dsh-runner.js'
import type { MemoryClientPort } from '../src/memory/client.js'
import type { MemorySnapshot } from '../src/memory/contracts.js'
import { MemoryLifecycle } from '../src/memory/lifecycle.js'
import type { EvidenceSet, MedicalEvidenceClientPort } from '../src/rag/contracts.js'

const rootAgent = {
  id: 'root-1',
  ctx: { systemPrompt: { section: vi.fn(() => vi.fn()) } },
} as unknown as Agent

function memorySnapshot(): MemorySnapshot {
  return {
    snapshotId: 'snapshot-1', userId: 'patient-1', sessionId: 'root-1', turn: 1,
    items: [{ kind: 'fact', content: 'synthetic patient history' }],
  }
}

function evidenceSet(query: string): EvidenceSet {
  return {
    query, mode: 'single',
    hits: [{
      evidenceId: 'evidence-1', rank: 1, title: 'Synthetic reference', snippet: 'synthetic external evidence',
      source: 'fixture', sourceType: 'guideline', corpus: 'test', sourceDocumentId: 'doc-1', chunkId: 'chunk-1',
      score: 0.9, retrievalQuery: query, retrievalQueries: [query], retrievalRound: 1, snippetTruncated: false,
    }],
    retrieval: {
      rounds: 1, generatedQueries: 1, uniqueDocuments: 1, candidateCount: 1, returnedEvidenceCount: 1,
      retrievalCalls: 1, plannerCalls: 0, retrievalLatencyMs: 1, plannerLatencyMs: 0, latencyMs: 1,
      estimatedContextTokens: 20, plannerModel: 'none', plannerPromptVersion: 'fixture',
      generatedQueryHashes: [], degraded: false,
    },
    corpusVersion: 'fixture-v1',
  }
}

function lifecycle() {
  const snapshot = memorySnapshot()
  const memoryClient: MemoryClientPort = {
    recall: vi.fn(async () => snapshot),
    commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
    sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
    stats: vi.fn(async userId => ({ userId, memoryWindowItems: 1, records: { raw: 0, facts: 1, episodes: 0 } })),
    forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 1 })),
    health: vi.fn(async () => ({ status: 'ok' as const })),
  }
  const instance = new MemoryLifecycle(memoryClient, { record: () => undefined }, () => 'patient-1')
  const session = {
    id: rootAgent.id,
    header: { id: rootAgent.id, version: 4, createdAt: 1, isSeeded: false },
  } as unknown as Session
  instance.observeSessionEvent(session, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: 1 } as never)
  instance.noteClaimed(rootAgent, { source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic case query' }] }, 1)
  return { instance, memoryClient }
}

describe('Huiyi DSH collaboration capability', () => {
  it('passes the current query, shared Memory snapshot, and separate RAG evidence to bounded spawn children', async () => {
    const { instance, memoryClient } = lifecycle()
    const evidenceClient: MedicalEvidenceClientPort = {
      search: vi.fn(async request => evidenceSet(request.query)),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const startRequests: Array<Record<string, unknown>> = []
    const start = vi.fn(async (_provider: string, request: Record<string, unknown>) => {
      startRequests.push(request)
      return {
        id: `child-${startRequests.length}`,
        result: Promise.resolve({
          stopReason: 'completed' as const,
          structured: { complexity: 'basic', rationaleSummary: 'Single-agent product path.' },
        }),
        dispose: vi.fn(async () => undefined),
      }
    })
    let registered: { execute(args: unknown, exec: ToolRunContext): Promise<unknown> } | undefined
    const ctx = {
      subagents: { list: () => ['spawn'], start },
      agents: { roots: () => [rootAgent] },
      tools: { register: (tool: any) => { registered = tool; return vi.fn() } },
      systemPrompt: { section: () => vi.fn() },
      on: () => {
        return vi.fn()
      },
    } as unknown as DshCollaborationContext & Context

    installDshCollaborationTool(ctx, instance, evidenceClient)
    const exec = { agent: rootAgent, signal: new AbortController().signal } as ToolRunContext
    const first = await registered!.execute({}, exec)
    const repeated = await registered!.execute({}, exec)

    expect(first).toMatchObject({
      status: 'completed', complexity: 'basic', context: {
        patientMemoryItemCount: 1, externalEvidenceHitCount: 1, externalEvidenceStatus: 'retrieved',
      },
    })
    expect(repeated).toEqual(first)
    expect(memoryClient.recall).toHaveBeenCalledTimes(1)
    expect(evidenceClient.search).toHaveBeenCalledWith(
      { query: 'Synthetic case query', mode: 'single', topK: 5 },
      expect.objectContaining({ signal: exec.signal }),
    )
    expect(start).toHaveBeenCalledTimes(1)
    expect(startRequests[0]).toMatchObject({ parent: rootAgent, maxDepth: 1, toolFilter: { allow: [] } })
    expect(rootAgent.ctx.systemPrompt.section).toHaveBeenCalledTimes(1)
    const prompt = (startRequests[0].prompt as Array<{ text: string }>)[0].text
    expect(prompt).toContain('Synthetic case query')
    expect(prompt).toContain('synthetic patient history')
    expect(prompt).toContain('synthetic external evidence')
    expect(prompt).not.toContain('snapshot-1')
    expect(JSON.stringify(first)).not.toContain('synthetic patient history')
    expect(JSON.stringify(first)).not.toContain('synthetic external evidence')
  })

  it('registers the collaboration tool only while native spawn is available', () => {
    const { instance } = lifecycle()
    const handlers = new Map<string, Array<(...args: any[]) => void>>()
    let providers: string[] = []
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const context = {
      inject: (_dependencies: string[], callback: (context: unknown) => void) => callback(context),
      on: (name: string, callback: (...args: any[]) => void) => {
        const listeners = handlers.get(name) ?? []
        listeners.push(callback)
        handlers.set(name, listeners)
        return vi.fn()
      },
      effect: () => undefined,
      subagents: { list: () => providers },
      agents: { roots: () => [] },
      tools: { register },
      systemPrompt: { section: () => vi.fn() },
    } as unknown as Context
    const evidenceClient = { search: vi.fn(), health: vi.fn() } as unknown as MedicalEvidenceClientPort

    installCollaborationWhenSpawnAvailable(context, instance, evidenceClient)
    expect(register).not.toHaveBeenCalled()
    providers = ['fork']
    for (const handler of handlers.get('subagent/provider-added') ?? []) handler({ name: 'fork' })
    expect(register).not.toHaveBeenCalled()
    providers = ['spawn']
    for (const handler of handlers.get('subagent/provider-added') ?? []) handler({ name: 'spawn' })
    expect(register).toHaveBeenCalledTimes(1)
    providers = []
    for (const handler of handlers.get('subagent/provider-removed') ?? []) handler('spawn')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
