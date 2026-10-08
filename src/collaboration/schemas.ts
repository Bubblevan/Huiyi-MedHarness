import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

const text: JsonSchemaNode = { type: 'string' }
const stringArray: JsonSchemaNode = { type: 'array', items: { type: 'string' } }

const specialistCandidate = {
  type: 'object',
  properties: { role: text, expertise: text },
  required: ['role', 'expertise'],
  additionalProperties: false,
} satisfies JsonSchemaNode

const teamMember = {
  type: 'object',
  properties: { role: text, expertise: text, lead: { type: 'boolean' } },
  required: ['role', 'expertise'],
  additionalProperties: false,
} satisfies JsonSchemaNode

const teamCandidate = {
  type: 'object',
  properties: {
    goal: text,
    members: { type: 'array', items: teamMember },
  },
  required: ['goal', 'members'],
  additionalProperties: false,
} satisfies JsonSchemaNode

export const complexityDecisionSchema = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['basic', 'intermediate', 'advanced'] },
    rationaleSummary: text,
  },
  required: ['complexity', 'rationaleSummary'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

export const recruitmentPlanSchema = {
  type: 'object',
  properties: { specialists: { type: 'array', items: specialistCandidate } },
  required: ['specialists'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

export const mdtPlanningSchema = {
  type: 'object',
  properties: { teams: { type: 'array', items: teamCandidate } },
  required: ['teams'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

export const specialistFindingSchema = {
  type: 'object',
  properties: {
    specialistId: text,
    role: text,
    summary: text,
    recommendation: text,
    confidence: { type: 'number' },
  },
  required: ['specialistId', 'role', 'summary'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

export const teamFindingSchema = {
  type: 'object',
  properties: {
    teamId: text,
    summary: text,
    memberFindings: { type: 'array', items: specialistFindingSchema },
  },
  required: ['teamId', 'summary', 'memberFindings'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

/** Team synthesis returns a summary; the orchestrator attaches source findings. */
export const teamSynthesisSchema = {
  type: 'object',
  properties: { teamId: text, summary: text },
  required: ['teamId', 'summary'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

export const moderatorDecisionSchema = {
  type: 'object',
  properties: {
    summary: text,
    agreement: text,
    disagreements: stringArray,
    recommendedAnswer: text,
  },
  required: ['summary', 'agreement', 'disagreements'],
  additionalProperties: false,
} satisfies ObjectJsonSchema

export type CollaborationSchemaName =
  | 'complexityDecision'
  | 'recruitmentPlan'
  | 'mdtPlanning'
  | 'specialistFinding'
  | 'teamFinding'
  | 'teamSynthesis'
  | 'moderatorDecision'

export const collaborationSchemas: Readonly<Record<CollaborationSchemaName, ObjectJsonSchema>> = {
  complexityDecision: complexityDecisionSchema,
  recruitmentPlan: recruitmentPlanSchema,
  mdtPlanning: mdtPlanningSchema,
  specialistFinding: specialistFindingSchema,
  teamFinding: teamFindingSchema,
  teamSynthesis: teamSynthesisSchema,
  moderatorDecision: moderatorDecisionSchema,
}
