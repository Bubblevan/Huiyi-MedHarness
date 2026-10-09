import type { Context } from '@deepseek-ai/cordis'
import { MemoryClient } from './memory/client.js'
import type { MemoryClientPort } from './memory/client.js'
import { installMemoryLifecycle, type MemoryLifecycle, type MemoryLifecycleOptions, type MemoryUserIdResolver } from './memory/lifecycle.js'
import { installMemoryTools } from './memory/tools.js'
import { MetadataMemoryTrace, type MemoryTraceSink } from './memory/trace.js'
import type { MedicalEvidenceClientPort } from './rag/contracts.js'
import { RagClient } from './rag/client.js'
import { installRagTool } from './rag/tool.js'
import { observeSessionEvents } from './trace.js'
import { installCollaborationWhenSpawnAvailable } from './collaboration/dsh-tool.js'
import type { CollaborationTraceSink } from './collaboration/trace.js'

export * from './memory/index.js'
export * from './rag/index.js'
export * from './case/index.js'
export * from './collaboration/index.js'

export const name = 'huiyi-medharness'
export const inject = ['tools', 'systemPrompt']

export interface ApplyWithIdentityOptions {
  readonly memory?: MemoryLifecycleOptions
  readonly memoryClient?: MemoryClientPort
  readonly memoryTrace?: MemoryTraceSink
  readonly collaborationTrace?: CollaborationTraceSink
}

export function apply(ctx: Context): void {
  applyWithIdentity(ctx, () => process.env.HUIYI_MEMORY_USER_ID?.trim() || undefined)
}

/** Install the bundle with a trusted host-owned patient/user identity resolver. */
export function applyWithIdentity(
  ctx: Context,
  resolveUserId: MemoryUserIdResolver,
  evidenceClient: MedicalEvidenceClientPort = new RagClient(),
  options: ApplyWithIdentityOptions = {},
): MemoryLifecycle {
  const memoryClient = options.memoryClient ?? new MemoryClient()
  const memoryTrace = options.memoryTrace ?? new MetadataMemoryTrace()
  const memoryLifecycle = installMemoryLifecycle(ctx, memoryClient, memoryTrace, resolveUserId, options.memory)
  installMemoryTools(ctx, memoryClient, memoryLifecycle)
  installRagTool(ctx, evidenceClient)
  installCollaborationWhenSpawnAvailable(ctx, memoryLifecycle, evidenceClient, {
    ...(options.collaborationTrace ? { trace: options.collaborationTrace } : {}),
  })
  observeSessionEvents(ctx)
  return memoryLifecycle
}

/** Mount only the memory capability for read-only benchmark profiles. */
export function applyMemoryOnly(
  ctx: Context,
  resolveUserId: MemoryUserIdResolver,
  options: MemoryLifecycleOptions,
  dependencies: { client?: MemoryClientPort; trace?: MemoryTraceSink } = {},
): MemoryLifecycle {
  const client = dependencies.client ?? new MemoryClient()
  const trace = dependencies.trace ?? new MetadataMemoryTrace()
  return installMemoryLifecycle(ctx, client, trace, resolveUserId, options)
}
