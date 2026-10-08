import type { CollaborationPolicy } from './policy.js'

export interface CollaborationBudgetSnapshot {
  readonly maxChildRuns: number
  readonly maxSpecialists: number
  readonly maxTeams: number
  readonly maxRounds: number
  readonly startedChildRuns: number
  readonly completedChildRuns: number
  readonly failedChildRuns: number
  readonly retainedSpecialists: number
  readonly retainedTeams: number
  readonly completedRounds: number
}

/** Mutable counters scoped to one collaboration call. */
export class CollaborationBudget {
  private started = 0
  private completed = 0
  private failed = 0
  private specialists = 0
  private teams = 0
  private rounds = 0

  constructor(private readonly policy: CollaborationPolicy) {}

  startChildRun(): boolean {
    if (this.started >= this.policy.maxChildRuns) return false
    this.started += 1
    return true
  }

  completeChildRun(): void {
    if (this.completed + this.failed >= this.started) throw new Error('cannot complete an unstarted child run')
    this.completed += 1
  }

  failChildRun(): void {
    if (this.completed + this.failed >= this.started) throw new Error('cannot fail an unstarted child run')
    this.failed += 1
  }

  setPlanCounts(specialistCount: number, teamCount: number): void {
    if (!Number.isSafeInteger(specialistCount) || specialistCount < 0 || specialistCount > this.policy.maxSpecialists) {
      throw new RangeError('specialist plan exceeds policy')
    }
    if (!Number.isSafeInteger(teamCount) || teamCount < 0 || teamCount > this.policy.maxTeams) {
      throw new RangeError('team plan exceeds policy')
    }
    this.specialists = specialistCount
    this.teams = teamCount
  }

  completeRound(): boolean {
    if (this.rounds >= this.policy.maxRounds) return false
    this.rounds += 1
    return true
  }

  snapshot(): CollaborationBudgetSnapshot {
    return {
      maxChildRuns: this.policy.maxChildRuns,
      maxSpecialists: this.policy.maxSpecialists,
      maxTeams: this.policy.maxTeams,
      maxRounds: this.policy.maxRounds,
      startedChildRuns: this.started,
      completedChildRuns: this.completed,
      failedChildRuns: this.failed,
      retainedSpecialists: this.specialists,
      retainedTeams: this.teams,
      completedRounds: this.rounds,
    }
  }
}
