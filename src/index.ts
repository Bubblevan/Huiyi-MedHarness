import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fixtureData from '../fixtures/evidence.json' with { type: 'json' }
import { searchMedicalEvidence, type EvidenceFixture, type EvidenceResult } from './evidence.js'
import { observeSessionEvents } from './trace.js'

export const name = 'huiyi-medharness'
export const inject = ['tools']

const fixtures = fixtureData as EvidenceFixture[]

const evidenceHitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    evidenceId: { type: 'string', required: true },
    rank: { type: 'integer', required: true },
    title: { type: 'string', required: true },
    snippet: { type: 'string', required: true },
    source: { type: 'string', required: true },
    sourceType: { type: 'string', required: true },
    score: { type: 'number', required: true },
  },
} as const

const evidenceResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    hits: { type: 'array', required: true, items: evidenceHitSchema },
  },
} as const

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'search_medical_evidence',
    description: 'Search the F0 synthetic medical-evidence fixture by deterministic keyword matching. Returns fabricated test data only; it is not clinical guidance.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search keywords or phrase; must be non-empty after trimming.',
      },
      topK: {
        type: 'integer',
        description: 'Maximum hits, integer 1 through 10; defaults to 3.',
        default: 3,
      },
    },
    output: {
      schema: evidenceResultSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec): Promise<EvidenceResult> {
      return searchMedicalEvidence(args, fixtures, exec.signal)
    },
  }))

  observeSessionEvents(ctx)
}
