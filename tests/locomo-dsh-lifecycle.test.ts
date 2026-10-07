import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, LlmRuntime, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { applyMemoryOnly } from '../src/index.js'
import type { MemoryClientPort } from '../src/memory/client.js'
import type { MemorySnapshot, MemoryTraceRecord } from '../src/memory/contracts.js'

class TwoStepAdapter extends LlmAdapter {
  calls = 0

  providerInfo(provider: string) {
    return { id: provider, name: 'Two-step test adapter' }
  }

  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 4096 } }
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'fixture-call-1' as never, name: 'fixture_echo', argumentsDelta: '{}' }
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: 'fixture-call-1' as never, name: 'fixture_echo', arguments: '{}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Completed.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed.' } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('HC-MEM-002 DSH lifecycle profile', () => {
  let ctx: Context | undefined
  let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined

  afterEach(async () => {
    await handle?.dispose()
    handle = undefined
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  it('runs one root DSH turn through two model steps with one automatic recall and no memory write', async () => {
    ctx = new Context()
    new TypertRegistry(ctx)
    new SessionStore(ctx)
    new SessionProjectionRegistry(ctx)
    new AgentRegistry(ctx)
    new LlmRuntime(ctx)
    new SystemPrompt(ctx, { includeHarnessIdentity: false })
    new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 1 })
    const adapter = new TwoStepAdapter()
    ctx.llm.registerAdapter(['locomo-test'], adapter)
    new AgentLoop(ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }))

    const snapshot: MemorySnapshot = {
      snapshotId: 'test-snapshot', userId: 'synthetic-user', sessionId: 'locomo-test-session', turn: 1,
      items: [{ kind: 'raw', content: 'Earlier synthetic fact', timestamp: '2023-01-01' }],
    }
    const client: MemoryClientPort = {
      recall: vi.fn(async () => snapshot),
      commitTurn: vi.fn(async () => ({ status: 'committed' as const, duplicate: false })),
      sessionEnd: vi.fn(async () => ({ status: 'skipped' as const, duplicate: false })),
      stats: vi.fn(async userId => ({ userId, memoryWindowItems: 0, records: { raw: 0, facts: 0, episodes: 0 } })),
      forget: vi.fn(async () => ({ status: 'forgotten' as const, recordsRemoved: 0 })),
      health: vi.fn(async () => ({ status: 'ok' as const })),
    }
    const trace: MemoryTraceRecord[] = []
    const eventKinds: string[] = []
    ctx.on('session/event', (_session, event) => {
      eventKinds.push(event.type === 'turn/end' ? `turn/end:${event.data.reason.kind}` : event.type)
    })
    ctx.tools.register(defineTool({
      name: 'fixture_echo',
      description: 'Test-only multi-step DSH fixture.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      async execute() { return 'fixture result' },
    }))
    applyMemoryOnly(ctx, () => 'synthetic-user', { automaticStrongRetrieve: true, readOnly: true }, {
      client,
      trace: { record: record => trace.push(record) },
    })

    expect(ctx.tools.schemas().map(item => item.name)).toEqual(['fixture_echo'])
    handle = await ctx.agents.create({
      sessionId: 'locomo-test-session' as SessionId,
      agentOptions: { provider: 'locomo-test', model: 'fixture-model' },
    })
    handle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'What did I previously say?' }],
    }))
    await handle.agent.whenIdle()

    expect(adapter.calls).toBe(2)
    expect(eventKinds).toContain('turn/end:completed')
    expect(client.recall).toHaveBeenCalledTimes(1)
    expect(client.recall).toHaveBeenCalledWith(expect.objectContaining({ strong: true }), expect.anything())
    expect(client.commitTurn).not.toHaveBeenCalled()
    expect(trace.filter(record => record.operation === 'automatic_recall')).toHaveLength(1)
    expect(trace.find(record => record.operation === 'commit')).toMatchObject({ status: 'skipped', errorClass: 'evaluation_read_only' })
  })
})
