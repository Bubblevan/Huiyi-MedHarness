import type { HealthCaseState } from '../case/contracts.js'
import type { SpecialistFinding, SpecialistSpec, TeamFinding, TeamSpec } from './contracts.js'

function bounded(value: string, limit: number): string {
  const normalized = value.normalize('NFKC').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

function caseContext(state: HealthCaseState): string {
  const sections = [`Case Query\n${bounded(state.query, 4_000)}`]
  const memory = state.patientMemory?.items.slice(0, 12) ?? []
  sections.push(memory.length
    ? `Patient Memory Snapshot (contextual history)\n${memory.map(item => `- [${item.kind}] ${bounded(item.content, 800)}`).join('\n')}`
    : 'Patient Memory Snapshot\nUnavailable')
  const evidence = state.externalEvidence?.hits.slice(0, 5) ?? []
  sections.push(evidence.length
    ? `External Evidence Snapshot\n${evidence.map(hit => `- [${bounded(hit.evidenceId, 80)}] ${bounded(hit.title, 300)}: ${bounded(hit.snippet, 1_000)}`).join('\n')}`
    : 'External Evidence Snapshot\nUnavailable')
  return sections.join('\n\n')
}

export function buildComplexityClassificationPrompt(state: HealthCaseState): string {
  return `Classify the execution complexity of this medical case as basic, intermediate, or advanced.\n\n${caseContext(state)}\n\nUse basic when the root single agent can answer. Use intermediate when distinct specialists should independently assess the case and a moderator should review their findings. Use advanced when multiple MDT groups with distinct goals should investigate and synthesize findings. Return a concise rationaleSummary; do not provide hidden reasoning.`
}

export function buildSpecialistRecruitmentPrompt(state: HealthCaseState, target: number): string {
  return `Recruit up to ${target} distinct medical specialists for an intermediate case. Return role and expertise for each specialist. Do not include hierarchy syntax or hidden reasoning.\n\n${caseContext(state)}`
}

export function buildMdtPlanningPrompt(state: HealthCaseState, maxTeams: number, maxSpecialists: number): string {
  return `Plan up to ${maxTeams} multidisciplinary teams using no more than ${maxSpecialists} specialists in total. Give every team a goal and members with role and expertise. Mark at most one lead member per team. Return a bounded plan without hidden reasoning.\n\n${caseContext(state)}`
}

export function buildSpecialistAnalysisPrompt(state: HealthCaseState, specialist: SpecialistSpec): string {
  return `Perform an independent medical assessment for your assigned role. Return a concise summary, an optional recommendation, and optional confidence from 0 to 1. Do not include hidden reasoning.\n\n${caseContext(state)}\n\nAssigned Role\n${bounded(specialist.role, 80)}\n\nAssigned Expertise\n${bounded(specialist.expertise, 500)}\n\nAssigned Specialist ID\n${specialist.id}`
}

export function buildPeerRefinementPrompt(
  state: HealthCaseState,
  specialist: SpecialistSpec,
  ownFinding: SpecialistFinding,
  peerFindings: readonly SpecialistFinding[],
): string {
  const peers = peerFindings
    .filter(finding => finding.specialistId !== ownFinding.specialistId)
    .slice(0, 8)
    .map(finding => `- ${bounded(finding.role, 80)}: ${bounded(finding.summary, 800)}${finding.recommendation ? ` Recommendation: ${bounded(finding.recommendation, 500)}` : ''}`)
  return `Refine your structured assessment using only these bounded peer summaries. Preserve your assigned role and ID. Return a concise summary and recommendation; do not include hidden reasoning.\n\n${caseContext(state)}\n\nAssigned Role\n${bounded(specialist.role, 80)}\n\nAssigned Expertise\n${bounded(specialist.expertise, 500)}\n\nRelevant Peer Summaries\n${peers.length ? peers.join('\n') : 'No peer summaries available'}\n\nYour Previous Finding\n${bounded(ownFinding.summary, 1_000)}${ownFinding.recommendation ? `\nRecommendation: ${bounded(ownFinding.recommendation, 500)}` : ''}`
}

export function buildTeamSynthesisPrompt(
  state: HealthCaseState,
  team: TeamSpec,
  findings: readonly SpecialistFinding[],
): string {
  const projected = findings.slice(0, 8).map(finding =>
    `- ${bounded(finding.role, 80)}: ${bounded(finding.summary, 800)}${finding.recommendation ? ` Recommendation: ${bounded(finding.recommendation, 500)}` : ''}`,
  )
  return `Synthesize the structured findings for this MDT goal. Return only teamId and a concise summary. Do not add member findings or hidden reasoning.\n\n${caseContext(state)}\n\nTeam Goal\n${bounded(team.goal, 300)}\n\nTeam Members\n${team.members.map(member => `- ${bounded(member.role, 80)} (${member.id})`).join('\n')}\n\nMember Findings\n${projected.join('\n')}`
}

export function buildModeratorPrompt(
  state: HealthCaseState,
  specialistFindings: readonly SpecialistFinding[],
  teamFindings: readonly TeamFinding[],
): string {
  const specialists = specialistFindings.slice(0, 12).map(finding =>
    `- ${bounded(finding.role, 80)}: ${bounded(finding.summary, 800)}${finding.recommendation ? ` Recommendation: ${bounded(finding.recommendation, 500)}` : ''}`,
  )
  const teams = teamFindings.slice(0, 4).map(finding => `- ${finding.teamId}: ${bounded(finding.summary, 1_000)}`)
  const recommendationGroups = new Map<string, string[]>()
  for (const finding of specialistFindings) {
    if (!finding.recommendation) continue
    const key = finding.recommendation.toLocaleLowerCase('en-US')
    const group = recommendationGroups.get(key) ?? []
    group.push(finding.role)
    recommendationGroups.set(key, group)
  }
  const disagreements = [...recommendationGroups.entries()]
    .filter(([, roles]) => roles.length < specialistFindings.length)
    .slice(0, 6)
    .map(([recommendation, roles]) => `- ${roles.join(', ')}: ${bounded(recommendation, 400)}`)
  return `Review the structured findings for decision support to the root DSH agent. State areas of agreement, disagreements, and a concise recommendation. Do not reproduce hidden reasoning or treat this as the root agent's final user-facing response.\n\n${caseContext(state)}\n\nSpecialist Summaries\n${specialists.length ? specialists.join('\n') : 'None'}\n\nTeam Summaries\n${teams.length ? teams.join('\n') : 'None'}\n\nDisagreements to Review\n${disagreements.length ? disagreements.join('\n') : 'No explicit recommendation conflict was detected.'}`
}
