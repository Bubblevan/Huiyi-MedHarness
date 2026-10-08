export type CaseComplexity = 'basic' | 'intermediate' | 'advanced'

export type CollaborationProfile = 'benchmark' | 'product'

export interface ComplexityDecision {
  readonly complexity: CaseComplexity
  readonly rationaleSummary: string
}

export interface SpecialistSpec {
  readonly id: string
  readonly role: string
  readonly expertise: string
}

export interface TeamSpec {
  readonly id: string
  readonly goal: string
  readonly leadSpecialistId?: string
  readonly members: readonly SpecialistSpec[]
}

export interface CollaborationPlan {
  readonly complexity: CaseComplexity
  readonly specialists: readonly SpecialistSpec[]
  readonly teams: readonly TeamSpec[]
}

export interface RecruitmentPlan {
  readonly specialists: readonly SpecialistSpec[]
}

export interface SpecialistFinding {
  readonly specialistId: string
  readonly role: string
  readonly summary: string
  readonly recommendation?: string
  readonly confidence?: number
}

export interface TeamFinding {
  readonly teamId: string
  readonly summary: string
  readonly memberFindings: readonly SpecialistFinding[]
}

export interface MdtPlan {
  readonly teams: readonly TeamSpec[]
}

export interface ModeratorDecision {
  readonly summary: string
  readonly agreement: string
  readonly disagreements: readonly string[]
  readonly recommendedAnswer?: string
}

export interface CollaborationSnapshot {
  readonly complexity: CaseComplexity
  readonly plan: CollaborationPlan
  readonly specialistFindings: readonly SpecialistFinding[]
  readonly teamFindings: readonly TeamFinding[]
  readonly moderator?: ModeratorDecision
  readonly execution: {
    readonly childRuns: number
    readonly failedChildRuns: number
    readonly completedRounds: number
    readonly degraded: boolean
  }
}
