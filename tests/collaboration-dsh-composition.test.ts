import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { applyWithIdentity } from '../src/index.js'
import type { MemoryClientPort } from '../src/memory/client.js'
import type { MedicalEvidenceClientPort } from '../src/rag/contracts.js'

describe('pinned DSH composition', () => {
  let context: Context | undefined
  const handles: Array<{ agent: Agent; dispose(): Promise<void> }> = []

  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.dispose()
    await context?.fiber.dispose()
    context = undefined
  })

  it('mounts collaboration in the normal bundle only for roots when native spawn is available', async () => {
    context = new Context()
    new TypertRegistry(context)
    new SessionStore(context)
    new SessionProjectionRegistry(context)
    new AgentRegistry(context)
    new LlmRuntime(context)
    new SystemPrompt(context, { includeHarnessIdentity: false })
    new ToolRuntime(context, { mode: 'native', maxParallelSubCalls: 1 })
    new AgentLoop(context, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }))
    new SubagentRuntime(context, SubagentRuntime.Config({ maxDepth: 1, maxActiveSubagents: 8 }))

    const piAiPlugin = Object.assign(PiAi.apply, { inject: PiAi.inject, Config: PiAi.Config })
    const spawnPlugin = Object.assign(Spawn.apply, { inject: Spawn.inject, Config: Spawn.Config })
    await context.plugin(piAiPlugin, { providers: {} })
    await context.plugin(spawnPlugin, { providerName: 'spawn' })
    expect(context.subagents.list()).toContain('spawn')

    const evidence = { search: async () => { throw new Error('must not execute during composition') }, health: async () => ({ status: 'ok' as const }) } as MedicalEvidenceClientPort
    applyWithIdentity(context, () => undefined, evidence, { memoryClient: {} as MemoryClientPort })

    const names = context.tools.schemas().map(tool => tool.name)
    expect(names).toContain('consult_clinical_team')
    expect(names).not.toContain('subagent')

    const root = await context.agents.create({
      sessionId: 'hc-ma-002-root' as SessionId,
      agentOptions: { provider: 'composition-test', model: 'fixture' },
    })
    handles.push(root)
    const child = await context.agents.create({
      sessionId: 'hc-ma-002-child' as SessionId,
      parentAgent: root.agent,
      agentOptions: { provider: 'composition-test', model: 'fixture' },
      setup(agentCtx) { agentCtx.tools.restrict({ allow: [] }) },
    })
    handles.push(child)

    const rootAssembly = await root.agent.ctx.systemPrompt.assemble(assembleContextFor(root.agent))
    const childAssembly = await child.agent.ctx.systemPrompt.assemble(assembleContextFor(child.agent))
    expect(renderPrompt(rootAssembly)).toContain('call consult_clinical_team once')
    expect(rootAssembly.tools.map(tool => tool.name)).toContain('consult_clinical_team')
    expect(renderPrompt(childAssembly)).not.toContain('call consult_clinical_team once')
    expect(childAssembly.tools.map(tool => tool.name)).not.toContain('consult_clinical_team')
  })
})
