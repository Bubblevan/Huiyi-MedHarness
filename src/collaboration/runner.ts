import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

export type ClinicalChildKind =
  | 'complexity-classifier'
  | 'specialist-recruiter'
  | 'mdt-planner'
  | 'specialist-analysis'
  | 'peer-refinement'
  | 'team-synthesis'
  | 'moderator'

export type ClinicalStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

export interface ClinicalChildRequest {
  readonly kind: ClinicalChildKind
  readonly label: string
  readonly roleLabel: string
  readonly prompt: string
  readonly persona: string
  readonly outputSchema: ObjectJsonSchema
  /** Domain validation runs while a DSH handle is still owned and disposable. */
  readonly decode: (value: unknown) => unknown
  readonly round?: number
  readonly teamId?: string
}

export type ClinicalChildResult =
  | {
      readonly status: 'completed'
      readonly value: unknown
      readonly runId?: string
      readonly stopReason: 'completed'
      readonly startedAt: number
      readonly endedAt: number
    }
  | {
      readonly status: 'failed'
      readonly failureClass: string
      readonly runId?: string
      readonly stopReason?: ClinicalStopReason
      readonly startedAt: number
      readonly endedAt: number
    }

export interface ClinicalChildRunner {
  run(parent: Agent, request: ClinicalChildRequest, signal: AbortSignal): Promise<ClinicalChildResult>
}
