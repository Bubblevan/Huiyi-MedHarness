import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ClinicalChildRequest, ClinicalChildResult, ClinicalChildRunner, ClinicalStopReason } from './runner.js'
import { safeFailureClass } from './trace.js'

interface DshSubagentResult {
  readonly structured?: unknown
  readonly stopReason: ClinicalStopReason
}

interface DshSubagentRun {
  readonly id: string
  readonly result: Promise<DshSubagentResult>
  dispose(): Promise<void>
}

interface DshSubagentStartRequest {
  readonly label: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly outputSchema: ObjectJsonSchema
  readonly maxDepth: number
  readonly toolFilter: ToolRestriction
  readonly persona: string
}

type PendingChildResult =
  | Omit<Extract<ClinicalChildResult, { status: 'completed' }>, 'endedAt'>
  | Omit<Extract<ClinicalChildResult, { status: 'failed' }>, 'endedAt'>

/** Narrow view of the pinned DSH service. `@deepseek-ai/dsh-subagent` augments Context when composed. */
export type DshCollaborationContext = Context & {
  readonly subagents: {
    list(): string[]
    start(provider: string, request: DshSubagentStartRequest): Promise<DshSubagentRun>
  }
}

export interface DshClinicalChildRunnerOptions {
  readonly provider?: string
}

/** One-shot child execution through the pinned DSH subagent service. */
export class DshClinicalChildRunner implements ClinicalChildRunner {
  private readonly provider: string
  private readonly maxDepth = 1
  private readonly toolFilter: ToolRestriction = { allow: [] }

  constructor(private readonly ctx: DshCollaborationContext, options: DshClinicalChildRunnerOptions = {}) {
    this.provider = options.provider ?? 'spawn'
  }

  async run(parent: Agent, request: ClinicalChildRequest, signal: AbortSignal): Promise<ClinicalChildResult> {
    const startedAt = Date.now()
    let run: DshSubagentRun | undefined
    let outcome: PendingChildResult | undefined
    let disposalFailed = false

    try {
      if (signal.aborted) {
        outcome = { status: 'failed', failureClass: 'Aborted', stopReason: 'aborted', startedAt }
      } else if (!this.ctx.subagents.list().includes(this.provider)) {
        outcome = { status: 'failed', failureClass: 'ProviderUnavailable', startedAt }
      } else {
        run = await this.ctx.subagents.start(this.provider, {
          label: request.label,
          prompt: [{ type: 'text', text: request.prompt }],
          parent,
          signal,
          outputSchema: request.outputSchema,
          maxDepth: this.maxDepth,
          toolFilter: this.toolFilter,
          persona: request.persona,
        })
        const result = await run.result
        if (result.stopReason !== 'completed') {
          outcome = {
            status: 'failed',
            failureClass: 'ChildNotCompleted',
            runId: run.id,
            stopReason: result.stopReason,
            startedAt,
          }
        } else if (result.structured === undefined) {
          outcome = {
            status: 'failed',
            failureClass: 'MissingStructuredOutput',
            runId: run.id,
            stopReason: 'completed',
            startedAt,
          }
        } else {
          try {
            const value = request.decode(result.structured)
            outcome = { status: 'completed', value, runId: run.id, stopReason: 'completed', startedAt }
          } catch (error: unknown) {
            outcome = {
              status: 'failed',
              failureClass: 'InvalidStructuredOutput',
              runId: run.id,
              stopReason: 'completed',
              startedAt,
            }
          }
        }
      }
    } catch (error: unknown) {
      outcome = {
        status: 'failed',
        failureClass: safeFailureClass(error),
        ...(run ? { runId: run.id } : {}),
        ...(signal.aborted ? { stopReason: 'aborted' as const } : {}),
        startedAt,
      }
    } finally {
      if (run) {
        try {
          await run.dispose()
        } catch {
          disposalFailed = true
        }
      }
    }

    const endedAt = Date.now()
    if (disposalFailed) {
      return {
        status: 'failed',
        failureClass: 'RunDisposalFailed',
        ...(run ? { runId: run.id } : {}),
        ...(outcome && 'stopReason' in outcome ? { stopReason: outcome.stopReason } : {}),
        startedAt,
        endedAt,
      }
    }
    return { ...(outcome ?? { status: 'failed', failureClass: 'UnknownChildFailure', startedAt }), endedAt } as ClinicalChildResult
  }
}
