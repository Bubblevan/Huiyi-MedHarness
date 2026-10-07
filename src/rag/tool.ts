import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RagClient } from './client.js'
import type { EvidenceSet, MedicalEvidenceClientPort } from './contracts.js'
import { validateMedicalEvidenceRequest } from './contracts.js'
import { renderEvidenceSet } from './render.js'

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
    corpus: { type: 'string', required: true },
    sourceDocumentId: { type: 'string', required: true },
    chunkId: { type: 'string', required: true },
    score: { type: 'number', required: true },
    retrievalQuery: { type: 'string', required: true },
    retrievalQueries: { type: 'array', required: true, items: { type: 'string' } },
    retrievalRound: { type: 'integer', required: true },
    snippetTruncated: { type: 'boolean', required: true },
    sourceUri: { type: 'string' },
  },
} as const

const retrievalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rounds: { type: 'integer', required: true },
    generatedQueries: { type: 'integer', required: true },
    uniqueDocuments: { type: 'integer', required: true },
    candidateCount: { type: 'integer', required: true },
    returnedEvidenceCount: { type: 'integer', required: true },
    retrievalCalls: { type: 'integer', required: true },
    plannerCalls: { type: 'integer', required: true },
    retrievalLatencyMs: { type: 'number', required: true },
    plannerLatencyMs: { type: 'number', required: true },
    latencyMs: { type: 'number', required: true },
    estimatedContextTokens: { type: 'integer', required: true },
    plannerModel: { type: 'string', required: true },
    plannerPromptVersion: { type: 'string', required: true },
    plannerInputTokens: { type: 'integer' },
    plannerOutputTokens: { type: 'integer' },
    generatedQueryHashes: { type: 'array', required: true, items: { type: 'string' } },
    degraded: { type: 'boolean', required: true },
    degradedErrorClass: { type: 'string' },
  },
} as const

const evidenceSetSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    mode: { type: 'string', enum: ['single', 'iterative'], required: true },
    hits: { type: 'array', required: true, items: evidenceHitSchema },
    retrieval: { ...retrievalSchema, required: true },
    corpusVersion: { type: 'string', required: true },
  },
} as const

export function installRagTool(ctx: Context, client: MedicalEvidenceClientPort = new RagClient()): void {
  ctx.tools.register(defineTool({
    name: 'search_medical_evidence',
    description: 'Search the prepared local medical-reference corpus. Returns source-backed evidence only, never a diagnosis or final answer. If the result is empty, weak, or an error, say so and do not invent retrieved evidence or citations.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Medical question or concept to search; must be non-empty.',
      },
      mode: {
        type: 'string',
        enum: ['single', 'iterative'],
        description: 'single runs one retrieval; iterative requests bounded follow-up evidence acquisition. Defaults to deployment configuration.',
      },
      topK: {
        type: 'integer',
        description: 'Maximum returned evidence items, from 1 through 10; the service applies its configured hard cap.',
      },
    },
    output: {
      schema: evidenceSetSchema,
      render: (_args, value) => [{ type: 'text', text: renderEvidenceSet(value as EvidenceSet) }],
    },
    async execute(args, exec): Promise<EvidenceSet> {
      const request = validateMedicalEvidenceRequest(args)
      return client.search(request, { signal: exec.signal })
    },
  }))
}
