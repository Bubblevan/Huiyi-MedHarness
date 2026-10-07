import type { Context } from '@deepseek-ai/cordis'
import { MemoryClient } from './memory/client.js'
import { installMemoryLifecycle, type MemoryUserIdResolver } from './memory/lifecycle.js'
import { installMemoryTools } from './memory/tools.js'
import { MetadataMemoryTrace } from './memory/trace.js'
import type { MedicalEvidenceClientPort } from './rag/contracts.js'
import { RagClient } from './rag/client.js'
import { installRagTool } from './rag/tool.js'
import { observeSessionEvents } from './trace.js'

export * from './memory/index.js'
export * from './rag/index.js'

export const name = 'huiyi-medharness'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context): void {
  applyWithIdentity(ctx, () => process.env.HUIYI_MEMORY_USER_ID?.trim() || undefined)
}

/** Install the bundle with a trusted host-owned patient/user identity resolver. */
export function applyWithIdentity(
  ctx: Context,
  resolveUserId: MemoryUserIdResolver,
  evidenceClient: MedicalEvidenceClientPort = new RagClient(),
): void {
  const memoryClient = new MemoryClient()
  const memoryTrace = new MetadataMemoryTrace()
  const memoryLifecycle = installMemoryLifecycle(ctx, memoryClient, memoryTrace, resolveUserId)
  installMemoryTools(ctx, memoryClient, memoryLifecycle)
  installRagTool(ctx, evidenceClient)
  observeSessionEvents(ctx)
}
