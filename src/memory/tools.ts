import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryClientPort } from './client.js'
import { MemoryClientError } from './client.js'
import type { MemoryStats } from './contracts.js'
import type { MemoryLifecycle } from './lifecycle.js'

const memoryItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['raw', 'fact', 'episode'], required: true },
    content: { type: 'string', required: true },
    timestamp: { type: 'string' },
    source: { type: 'string' },
  },
} as const

const recallItemsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', required: true, items: memoryItemSchema },
  },
} as const

function userIdFor(agent: Agent | undefined, lifecycle: MemoryLifecycle): string {
  const userId = agent ? lifecycle.userIdForAgent(agent) : undefined
  if (!userId) throw new MemoryClientError('unavailable', 'Trusted memory identity is not configured')
  return userId
}

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function installMemoryTools(ctx: Context, client: MemoryClientPort, lifecycle: MemoryLifecycle): void {
  ctx.tools.register(defineTool({
    name: 'recall_patient_memory',
    description: 'Search prior user/patient memory only when the automatically supplied patient context is insufficient. Returned items are historical context, not medical evidence.',
    parameters: {
      query: { type: 'string', required: true, description: 'A concise query about information the user previously shared.' },
      strong: { type: 'boolean', default: false, description: 'Request a stronger AMA retrieval pass when the ordinary recalled context is insufficient.' },
    },
    output: {
      schema: recallItemsSchema,
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new MemoryClientError('unavailable', 'Memory recall requires an active DSH agent')
      const snapshot = await lifecycle.manualRecall(agent, args.query, args.strong ?? false, exec.signal)
      // The model receives only returned history, never runtime/session IDs or
      // retrieval/debug counters from the internal MemorySnapshot.
      return { items: snapshot.items.map(item => ({ ...item })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inspect_memory_status',
    description: 'Inspect counts and health metadata for the current patient memory store. Does not return remembered text.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'string', required: true },
          memoryWindowItems: { type: 'integer', required: true },
          records: {
            type: 'object',
            additionalProperties: false,
            properties: {
              raw: { type: 'integer', required: true },
              facts: { type: 'integer', required: true },
              episodes: { type: 'integer', required: true },
            },
          },
        },
      } as const,
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: 15000,
    async execute(_args, exec): Promise<MemoryStats> {
      return client.stats(userIdFor(exec.agent, lifecycle), { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forget_patient_memory',
    description: 'Delete all stored memory for the current patient. This destructive operation requires DSH user approval and an explicit confirmation value.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Set true only after the user explicitly asked to forget all stored patient memory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['forgotten'], required: true },
          recordsRemoved: { type: 'integer', required: true },
        },
      } as const,
      render: (_args, value) => renderJson(value),
    },
    timeoutMs: 30000,
    async execute(args, exec): Promise<{ status: 'forgotten'; recordsRemoved: number }> {
      if (!args.confirm) throw new MemoryClientError('invalid_request', 'Explicit forget confirmation is required')
      return client.forget({ userId: userIdFor(exec.agent, lifecycle), confirmation: 'forget all patient memory' }, { signal: exec.signal })
    },
  }))

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'forget_patient_memory') return next()
    return {
      kind: 'ask',
      reason: 'User approval is required before deleting all stored patient memory.',
      displayReason: {
        en: 'Delete all stored patient memory?',
        zh: '确认删除该用户的全部长期记忆？',
      },
    }
  })
}
