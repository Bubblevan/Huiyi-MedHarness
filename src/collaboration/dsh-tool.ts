import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { SystemPrompt as DshSystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HealthCaseState } from '../case/contracts.js'
import type { MemoryLifecycle } from '../memory/lifecycle.js'
import type { MedicalEvidenceClientPort } from '../rag/contracts.js'
import type { CaseComplexity, CollaborationSnapshot } from './contracts.js'
import { DshClinicalChildRunner } from './dsh-runner.js'
import type { DshCollaborationContext } from './dsh-runner.js'
import { CollaborationOrchestrator } from './orchestrator.js'
import type { CollaborationTraceSink } from './trace.js'

type CollaborationCapabilityContext = Context & { readonly systemPrompt: DshSystemPrompt }

interface CollaborationToolResult {
  readonly status: 'completed' | 'degraded' | 'unavailable'
  readonly complexity: CaseComplexity
  readonly plan: {
    readonly specialists: { readonly id: string; readonly role: string; readonly expertise: string }[]
    readonly teams: {
      readonly id: string
      readonly goal: string
      readonly leadSpecialistId?: string
      readonly members: { readonly id: string; readonly role: string; readonly expertise: string }[]
    }[]
  }
  readonly specialistFindings: {
    readonly specialistId: string
    readonly role: string
    readonly summary: string
    readonly recommendation?: string
    readonly confidence?: number
  }[]
  readonly teamFindings: {
    readonly teamId: string
    readonly summary: string
    readonly memberFindings: {
      readonly specialistId: string
      readonly role: string
      readonly summary: string
      readonly recommendation?: string
      readonly confidence?: number
    }[]
  }[]
  readonly moderator?: {
    readonly summary: string
    readonly agreement: string
    readonly disagreements: string[]
    readonly recommendedAnswer?: string
  }
  readonly context: {
    readonly patientMemoryItemCount: number
    readonly externalEvidenceHitCount: number
    readonly externalEvidenceStatus: 'retrieved' | 'empty' | 'degraded' | 'unavailable'
  }
  readonly execution: CollaborationSnapshot['execution']
}

const findingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    specialistId: { type: 'string', required: true },
    role: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    recommendation: { type: 'string' },
    confidence: { type: 'number' },
  },
} as const

const specialistSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    role: { type: 'string', required: true },
    expertise: { type: 'string', required: true },
  },
} as const

const teamSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    goal: { type: 'string', required: true },
    leadSpecialistId: { type: 'string' },
    members: { type: 'array', required: true, items: specialistSchema },
  },
} as const

const moderatorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', required: true },
    agreement: { type: 'string', required: true },
    disagreements: { type: 'array', required: true, items: { type: 'string' } },
    recommendedAnswer: { type: 'string' },
  },
} as const

const collaborationResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'degraded', 'unavailable'], required: true },
    complexity: { type: 'string', enum: ['basic', 'intermediate', 'advanced'], required: true },
    plan: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        specialists: { type: 'array', required: true, items: specialistSchema },
        teams: { type: 'array', required: true, items: teamSchema },
      },
    },
    specialistFindings: { type: 'array', required: true, items: findingSchema },
    teamFindings: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          teamId: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          memberFindings: { type: 'array', required: true, items: findingSchema },
        },
      },
    },
    moderator: moderatorSchema,
    context: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        patientMemoryItemCount: { type: 'integer', required: true },
        externalEvidenceHitCount: { type: 'integer', required: true },
        externalEvidenceStatus: { type: 'string', enum: ['retrieved', 'empty', 'degraded', 'unavailable'], required: true },
      },
    },
    execution: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        childRuns: { type: 'integer', required: true },
        failedChildRuns: { type: 'integer', required: true },
        completedRounds: { type: 'integer', required: true },
        degraded: { type: 'boolean', required: true },
      },
    },
  },
} as const

/** Register a Huiyi-controlled product collaboration tool on a DSH root context. */
export function installDshCollaborationTool(
  ctx: CollaborationCapabilityContext,
  memory: MemoryLifecycle,
  evidence: MedicalEvidenceClientPort,
  options: { readonly trace?: CollaborationTraceSink } = {},
): () => void {
  const orchestrator = new CollaborationOrchestrator(new DshClinicalChildRunner(ctx as unknown as DshCollaborationContext), options.trace)
  const perAgentTurn = new WeakMap<Agent, { readonly turn: number; readonly result: Promise<CollaborationToolResult> }>()
  const rootPolicyDisposers = new Map<Agent, () => void>()
  const registerRootPolicy = (agent: Agent): void => {
    // DSH runtime ownership, rather than durable fork ancestry, identifies roots.
    if (!ctx.agents.roots().some(root => root === agent) || rootPolicyDisposers.has(agent)) return
    const dispose = agent.ctx.systemPrompt.section({
      name: 'huiyi:adaptive-collaboration-policy',
      order: 250,
      text: 'For a medically complex question that benefits from distinct clinical perspectives, call consult_clinical_team once before drafting the answer. It classifies complexity and may return structured specialist or MDT decision support. For basic cases, continue as the root single agent. The collaboration result is advisory input: review it alongside patient history and external medical evidence, communicate uncertainty, and remain responsible for the final user-facing response.',
    })
    rootPolicyDisposers.set(agent, dispose)
  }
  const onAgentCreated = ({ agent }: { readonly agent: Agent }): undefined => {
    registerRootPolicy(agent)
    return undefined
  }
  const onAgentDisposed = ({ agent }: { readonly agent: Agent }): void => { rootPolicyDisposers.delete(agent) }
  const disposeCreatedListener = ctx.on('agent/created', onAgentCreated)
  const disposeDisposedListener = ctx.on('agent/disposed', onAgentDisposed)
  for (const agent of ctx.agents.roots()) registerRootPolicy(agent)

  const disposeTool = ctx.tools.register(defineTool({
    name: 'consult_clinical_team',
    description: 'Request a bounded MDAgents-derived adaptive medical collaboration review. Huiyi supplies the current case, patient-memory snapshot, and local medical evidence. The result is decision support; the root agent remains responsible for the user-facing response.',
    parameters: {},
    output: {
      schema: collaborationResultSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 600000,
    async execute(_args, exec): Promise<CollaborationToolResult> {
      const agent = exec.agent
      if (!agent) return unavailableResult('unavailable')

      const turn = memory.currentTurn(agent.id)
      const query = memory.queryForAgent(agent.id).trim()
      if (turn === undefined || !query) return unavailableResult('unavailable')

      const cached = perAgentTurn.get(agent)
      if (cached?.turn === turn) return cached.result

      const result = collaborateForTurn({ agent, turn, query, signal: exec.signal })
      perAgentTurn.set(agent, { turn, result })
      return result
    },
  }))

  return () => {
    disposeTool()
    disposeCreatedListener()
    disposeDisposedListener()
    for (const dispose of rootPolicyDisposers.values()) dispose()
    rootPolicyDisposers.clear()
  }

  async function collaborateForTurn(input: {
    readonly agent: Agent
    readonly turn: number
    readonly query: string
    readonly signal: AbortSignal
  }): Promise<CollaborationToolResult> {
    let patientMemory
    try {
      patientMemory = await memory.recallOnce(input.agent, input.signal)
    } catch {
      // MemoryLifecycle normally degrades to an empty snapshot; keep this
      // capability fail-open if a host supplied a custom lifecycle implementation.
    }

    let externalEvidence: HealthCaseState['externalEvidence']
    let externalEvidenceStatus: CollaborationToolResult['context']['externalEvidenceStatus'] = 'unavailable'
    try {
      externalEvidence = await evidence.search({ query: input.query, mode: 'single', topK: 5 }, { signal: input.signal })
      externalEvidenceStatus = externalEvidence.retrieval.degraded
        ? 'degraded'
        : externalEvidence.hits.length > 0 ? 'retrieved' : 'empty'
    } catch {
      externalEvidenceStatus = 'unavailable'
    }

    if (input.signal.aborted) return unavailableResult('degraded', externalEvidenceStatus)

    const caseState: HealthCaseState = {
      query: input.query,
      ...(patientMemory ? { patientMemory } : {}),
      ...(externalEvidence ? { externalEvidence } : {}),
    }

    try {
      const snapshot = await orchestrator.collaborate({
        parentAgent: input.agent,
        caseState,
        profile: 'product',
        signal: input.signal,
      })
      return {
        status: snapshot.execution.degraded ? 'degraded' : 'completed',
        complexity: snapshot.complexity,
        plan: {
          specialists: snapshot.plan.specialists.map(specialist => ({ ...specialist })),
          teams: snapshot.plan.teams.map(team => ({
            ...team,
            members: team.members.map(member => ({ ...member })),
          })),
        },
        specialistFindings: snapshot.specialistFindings.map(finding => ({ ...finding })),
        teamFindings: snapshot.teamFindings.map(finding => ({
          ...finding,
          memberFindings: finding.memberFindings.map(member => ({ ...member })),
        })),
        ...(snapshot.moderator ? {
          moderator: { ...snapshot.moderator, disagreements: [...snapshot.moderator.disagreements] },
        } : {}),
        context: {
          patientMemoryItemCount: patientMemory?.items.length ?? 0,
          externalEvidenceHitCount: externalEvidence?.hits.length ?? 0,
          externalEvidenceStatus,
        },
        execution: { ...snapshot.execution },
      }
    } catch {
      return unavailableResult('degraded', externalEvidenceStatus)
    }
  }
}

/**
 * Wait for DSH's native subagent service and mount the capability only while
 * the configured fresh-child `spawn` provider is available.
 */
export function installCollaborationWhenSpawnAvailable(
  ctx: Context,
  memory: MemoryLifecycle,
  evidence: MedicalEvidenceClientPort,
  options: { readonly trace?: CollaborationTraceSink } = {},
){
  const mount = (injectedCtx: Context): void => {
    const service = injectedCtx as CollaborationCapabilityContext
    let disposeTool: (() => void) | undefined

    const synchronize = (): void => {
      const spawnAvailable = service.subagents.list().includes('spawn')
      if (spawnAvailable && !disposeTool) {
        disposeTool = installDshCollaborationTool(service, memory, evidence, options)
      } else if (!spawnAvailable && disposeTool) {
        disposeTool()
        disposeTool = undefined
      }
    }

    synchronize()
    injectedCtx.on('subagent/provider-added', (provider: SubagentProvider) => {
      if (provider.name === 'spawn') synchronize()
    })
    injectedCtx.on('subagent/provider-removed', providerName => {
      if (providerName === 'spawn') synchronize()
    })
    injectedCtx.effect(() => () => {
      disposeTool?.()
      disposeTool = undefined
    }, 'huiyi-collaboration.tool')
  }

  const existing = (ctx as Context & { readonly subagents?: DshCollaborationContext['subagents'] }).subagents
  if (existing) {
    mount(ctx)
    return
  }
  return ctx.inject(['subagents'], mount)
}

function unavailableResult(
  status: 'unavailable' | 'degraded',
  externalEvidenceStatus: CollaborationToolResult['context']['externalEvidenceStatus'] = 'unavailable',
): CollaborationToolResult {
  return {
    status,
    complexity: 'basic',
    plan: { specialists: [], teams: [] },
    specialistFindings: [],
    teamFindings: [],
    context: { patientMemoryItemCount: 0, externalEvidenceHitCount: 0, externalEvidenceStatus },
    execution: { childRuns: 0, failedChildRuns: 0, completedRounds: 0, degraded: true },
  }
}
