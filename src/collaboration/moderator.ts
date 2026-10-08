import type { HealthCaseState } from '../case/contracts.js'
import type { SpecialistFinding, TeamFinding } from './contracts.js'
import { decodeModeratorDecision } from './planner.js'
import { buildModeratorPrompt } from './prompts.js'
import { moderatorDecisionSchema } from './schemas.js'
import type { ClinicalChildRequest } from './runner.js'

export function buildModeratorRequest(
  caseState: HealthCaseState,
  specialistFindings: readonly SpecialistFinding[],
  teamFindings: readonly TeamFinding[],
): ClinicalChildRequest {
  return {
    kind: 'moderator',
    label: 'clinical-collaboration-moderator',
    roleLabel: 'moderator',
    prompt: buildModeratorPrompt(caseState, specialistFindings, teamFindings),
    persona: 'You are a cautious clinical moderator. Review bounded structured findings and report agreement, disagreements, and decision support. Do not claim to replace the root clinical agent.',
    outputSchema: moderatorDecisionSchema,
    decode: decodeModeratorDecision,
  }
}
