import type { CollaborationProfile } from './contracts.js'

export interface CollaborationPolicy {
  readonly profile: CollaborationProfile
  readonly provider: 'spawn'
  readonly inheritsParentContext: false
  readonly maxDepth: 1
  readonly maxChildRuns: number
  readonly maxSpecialists: number
  readonly maxTeams: number
  readonly specialistsPerTeam: number
  readonly recruitmentTarget: number
  readonly maxRounds: number
  readonly maxTurnsPerRound: number
  readonly peerRefinementEnabled: boolean
  readonly maxConcurrency: number
}

/** Pinned MDAgents structural defaults for parity-oriented future evaluation. */
export const benchmarkPolicy: CollaborationPolicy = Object.freeze({
  profile: 'benchmark',
  provider: 'spawn',
  inheritsParentContext: false,
  maxDepth: 1,
  maxChildRuns: 128,
  maxSpecialists: 9,
  maxTeams: 3,
  specialistsPerTeam: 3,
  recruitmentTarget: 5,
  maxRounds: 5,
  maxTurnsPerRound: 5,
  peerRefinementEnabled: true,
  maxConcurrency: 5,
})

/** Bounded default for internet-hospital product composition. */
export const productPolicy: CollaborationPolicy = Object.freeze({
  profile: 'product',
  provider: 'spawn',
  inheritsParentContext: false,
  maxDepth: 1,
  maxChildRuns: 16,
  maxSpecialists: 3,
  maxTeams: 2,
  specialistsPerTeam: 3,
  recruitmentTarget: 3,
  maxRounds: 1,
  maxTurnsPerRound: 1,
  peerRefinementEnabled: false,
  maxConcurrency: 3,
})

export function policyFor(profile: CollaborationProfile): CollaborationPolicy {
  return profile === 'benchmark' ? benchmarkPolicy : productPolicy
}
