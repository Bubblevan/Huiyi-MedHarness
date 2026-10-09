import type {
  CaseComplexity,
  CollaborationPlan,
  ComplexityDecision,
  SpecialistFinding,
  SpecialistSpec,
  TeamFinding,
  TeamSpec,
} from './contracts.js'
import type { CollaborationPolicy } from './policy.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (normalized.length === 0 || normalized.length > maxLength) return undefined
  return normalized
}

export function decodeComplexityDecision(value: unknown): ComplexityDecision {
  if (!isRecord(value) || !hasOnlyKeys(value, ['complexity', 'rationaleSummary'])) {
    throw new TypeError('invalid complexity decision object')
  }
  const complexity = value.complexity
  if (complexity !== 'basic' && complexity !== 'intermediate' && complexity !== 'advanced') {
    throw new TypeError('invalid case complexity')
  }
  if (typeof value.rationaleSummary !== 'string') throw new TypeError('invalid complexity rationale summary type')
  const rationaleSummary = value.rationaleSummary.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!rationaleSummary) throw new TypeError('empty complexity rationale summary')
  if (rationaleSummary.length > 500) throw new TypeError('overlong complexity rationale summary')
  return { complexity, rationaleSummary }
}

function normalizeSpecialists(
  candidates: unknown,
  maxCount: number,
  idPrefix = 'specialist',
): SpecialistSpec[] {
  if (!Array.isArray(candidates)) return []
  const output: SpecialistSpec[] = []
  const seenRoles = new Set<string>()
  for (const candidate of candidates) {
    if (output.length >= maxCount) break
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['id', 'role', 'expertise', 'lead'])) continue
    const role = boundedText(candidate.role, 80)
    const expertise = boundedText(candidate.expertise, 500)
    if (!role || !expertise) continue
    const canonicalRole = role.toLocaleLowerCase('en-US')
    if (seenRoles.has(canonicalRole)) continue
    seenRoles.add(canonicalRole)
    output.push({ id: `${idPrefix}-${output.length + 1}`, role, expertise })
  }
  return output
}

export function planFromRecruitment(
  complexity: 'intermediate',
  value: unknown,
  policy: CollaborationPolicy,
): CollaborationPlan {
  if (!isRecord(value) || !hasOnlyKeys(value, ['specialists']) || !Array.isArray(value.specialists)) {
    throw new TypeError('invalid recruitment plan')
  }
  const specialists = normalizeSpecialists(
    value.specialists,
    Math.min(policy.maxSpecialists, policy.recruitmentTarget),
  )
  if (specialists.length === 0) throw new TypeError('recruitment plan has no valid specialists')
  return { complexity, specialists, teams: [] }
}

export function planFromMdt(value: unknown, policy: CollaborationPolicy): CollaborationPlan {
  if (!isRecord(value) || !hasOnlyKeys(value, ['teams']) || !Array.isArray(value.teams)) {
    throw new TypeError('invalid MDT plan')
  }

  const candidates: Array<{ goal: string; members: unknown[] }> = []
  for (const candidate of value.teams) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['id', 'goal', 'members', 'leadSpecialistId'])) continue
    const goal = boundedText(candidate.goal, 300)
    if (!goal || !Array.isArray(candidate.members)) continue
    const members = candidate.members.filter(member =>
      isRecord(member) && hasOnlyKeys(member, ['id', 'role', 'expertise', 'lead']),
    )
    candidates.push({ goal, members })
  }

  const retained: TeamSpec[] = []
  const flattened: SpecialistSpec[] = []
  let remainingSpecialists = policy.maxSpecialists
  const cappedTeams = candidates.slice(0, policy.maxTeams)

  for (let teamIndex = 0; teamIndex < cappedTeams.length; teamIndex += 1) {
    const candidate = cappedTeams[teamIndex]
    const futureTeamReserve = cappedTeams.length - teamIndex - 1
    const available = Math.max(0, remainingSpecialists - futureTeamReserve)
    const members = normalizeSpecialists(
      candidate.members,
      Math.min(policy.specialistsPerTeam, available),
      `team-${teamIndex + 1}-specialist`,
    )
    if (members.length === 0) continue

    const explicitLead = candidate.members.find((member): member is Record<string, unknown> =>
      isRecord(member) && member.lead === true,
    )
    const explicitLeadRole = explicitLead ? boundedText(explicitLead.role, 80)?.toLocaleLowerCase('en-US') : undefined
    const lead = explicitLeadRole
      ? members.find(member => member.role.toLocaleLowerCase('en-US') === explicitLeadRole)
      : undefined
    const id = `team-${teamIndex + 1}`
    retained.push({
      id,
      goal: candidate.goal,
      ...(lead ?? members[0] ? { leadSpecialistId: (lead ?? members[0]).id } : {}),
      members,
    })
    flattened.push(...members)
    remainingSpecialists -= members.length
  }

  if (retained.length === 0 || flattened.length === 0) throw new TypeError('MDT plan has no valid teams')

  return { complexity: 'advanced', specialists: flattened, teams: retained }
}

export function emptyCollaborationPlan(complexity: CaseComplexity): CollaborationPlan {
  return { complexity, specialists: [], teams: [] }
}

export function decodeSpecialistFinding(value: unknown, assigned: SpecialistSpec): SpecialistFinding {
  if (!isRecord(value) || !hasOnlyKeys(value, ['specialistId', 'role', 'summary', 'recommendation', 'confidence'])) {
    throw new TypeError('invalid specialist finding object')
  }
  const specialistId = boundedText(value.specialistId, 100)
  const role = boundedText(value.role, 80)
  const summary = boundedText(value.summary, 2_000)
  const recommendation = value.recommendation === undefined ? undefined : boundedText(value.recommendation, 1_000)
  const confidence = value.confidence
  if (specialistId !== assigned.id || role !== assigned.role || !summary) throw new TypeError('specialist finding identity mismatch')
  if (value.recommendation !== undefined && !recommendation) throw new TypeError('invalid specialist recommendation')
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new TypeError('invalid specialist confidence')
  }
  return {
    specialistId,
    role,
    summary,
    ...(recommendation ? { recommendation } : {}),
    ...(typeof confidence === 'number' ? { confidence } : {}),
  }
}

export function decodeTeamFindingSummary(
  value: unknown,
  team: TeamSpec,
  memberFindings: readonly SpecialistFinding[],
): TeamFinding {
  if (!isRecord(value) || !hasOnlyKeys(value, ['teamId', 'summary'])) throw new TypeError('invalid team finding summary')
  const teamId = boundedText(value.teamId, 100)
  const summary = boundedText(value.summary, 2_000)
  if (teamId !== team.id || !summary || memberFindings.length === 0) throw new TypeError('team finding identity mismatch')
  return { teamId, summary, memberFindings: [...memberFindings] }
}

export function decodeModeratorDecision(value: unknown): import('./contracts.js').ModeratorDecision {
  if (!isRecord(value) || !hasOnlyKeys(value, ['summary', 'agreement', 'disagreements', 'recommendedAnswer'])) {
    throw new TypeError('invalid moderator decision object')
  }
  const summary = boundedText(value.summary, 2_000)
  const agreement = boundedText(value.agreement, 1_000)
  const recommendedAnswer = value.recommendedAnswer === undefined ? undefined : boundedText(value.recommendedAnswer, 1_000)
  if (!summary || !agreement || !Array.isArray(value.disagreements)) throw new TypeError('invalid moderator decision fields')
  if (value.recommendedAnswer !== undefined && !recommendedAnswer) throw new TypeError('invalid moderator recommendation')
  const disagreements = value.disagreements.map(item => boundedText(item, 500))
  if (disagreements.some(item => !item)) throw new TypeError('invalid moderator disagreement')
  return {
    summary,
    agreement,
    disagreements: disagreements as string[],
    ...(recommendedAnswer ? { recommendedAnswer } : {}),
  }
}
