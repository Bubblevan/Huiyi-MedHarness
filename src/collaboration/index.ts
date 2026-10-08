import type { CollaborationTraceSink } from './trace.js'
import { DshClinicalChildRunner } from './dsh-runner.js'
import type { DshCollaborationContext, DshClinicalChildRunnerOptions } from './dsh-runner.js'
import { CollaborationOrchestrator } from './orchestrator.js'

export * from './budget.js'
export * from './contracts.js'
export * from './dsh-runner.js'
export * from './moderator.js'
export * from './orchestrator.js'
export * from './planner.js'
export * from './policy.js'
export * from './prompts.js'
export * from './runner.js'
export * from './schemas.js'
export * from './trace.js'

export interface InstallCollaborationOptions extends DshClinicalChildRunnerOptions {
  readonly trace?: CollaborationTraceSink
}

/**
 * Explicit host composition for HC-MA-001. This does not run during the normal
 * Huiyi bundle apply() path and does not register a model-facing delegation tool.
 */
export function installCollaboration(
  ctx: DshCollaborationContext,
  options: InstallCollaborationOptions = {},
): CollaborationOrchestrator {
  return new CollaborationOrchestrator(new DshClinicalChildRunner(ctx, options), options.trace)
}
