import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

export const name = 'huiyi-rag-parity-eval'
export const inject = ['tools', 'systemPrompt']

const INTERNAL_RESEARCH_URL = 'http://127.0.0.1:8322/_internal/eval/rag/imedrag'
const INTERNAL_MEDRAG_URL = 'http://127.0.0.1:8322/_internal/eval/rag/medrag'
const FINAL_JSON_INSTRUCTION = "Output the answer in JSON: {'answer': your_answer (A/B/C/D)}"
const I_MEDRAG_SYSTEM = 'You are a helpful medical assistant, and your task is to answer the given question following the instructions given by the user. '
const MEDRAG_SYSTEM = 'You are a helpful medical expert, and your task is to answer a multi-choice medical question using the relevant documents. Please first think step-by-step and then choose the answer from the provided options. Organize your output in a json formatted as Dict{"step_by_step_thinking": Str(explanation), "answer_choice": Str{A/B/C/...}}. Your responses will be used for research purposes only, so please have a definite answer.'
const COT_SYSTEM = 'You are a helpful medical expert, and your task is to answer a multi-choice medical question. Please first think step-by-step and then choose the answer from the provided options. Organize your output in a json formatted as Dict{"step_by_step_thinking": Str(explanation), "answer_choice": Str{A/B/C/...}}. Your responses will be used for research purposes only, so please have a definite answer.'

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    caseId: { type: 'string', required: true },
    history: { type: 'string', required: true },
    roundsCompleted: { type: 'integer', required: true },
    generatedQueries: { type: 'integer', required: true },
    modelCalls: { type: 'integer', required: true },
    retrievalCalls: { type: 'integer', required: true },
    inputTokens: { type: 'integer', required: true },
    outputTokens: { type: 'integer', required: true },
    retrievalLatencyMs: { type: 'number', required: true },
    modelLatencyMs: { type: 'number', required: true },
    observations: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'integer', required: true },
          query: { type: 'string', required: true },
          queryHash: { type: 'string', required: true },
          answer: { type: 'string', required: true },
          answerHash: { type: 'string', required: true },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true },
                corpus: { type: 'string', required: true },
                sourceDocumentId: { type: 'string', required: true },
                chunkId: { type: 'string', required: true },
                rank: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
    },
    corpusVersion: { type: 'string', required: true },
    plannerModel: { type: 'string', required: true },
    promptVersion: { type: 'string', required: true },
    latencyMs: { type: 'number', required: true },
    parseFailures: { type: 'integer', required: true },
  },
}

const retrievalOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    caseId: { type: 'string', required: true },
    documents: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: { type: 'string', required: true },
          corpus: { type: 'string', required: true },
          sourceDocumentId: { type: 'string', required: true },
          chunkId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          score: { type: 'number', required: true },
        },
      },
    },
    context: { type: 'string', required: true },
    corpusVersion: { type: 'string', required: true },
    retrievalLatencyMs: { type: 'number', required: true },
  },
}

export function apply(ctx) {
  const method = process.env.HUIYI_RAG_BENCHMARK_METHOD ?? 'imedrag'
  if (!['imedrag', 'medrag', 'cot'].includes(method)) {
    throw new Error('HUIYI_RAG_BENCHMARK_METHOD must be cot, medrag, or imedrag')
  }

  const toolName = method === 'imedrag' ? 'research_medical_question' : 'retrieve_medical_documents'
  const methodSystem = method === 'imedrag' ? I_MEDRAG_SYSTEM : method === 'medrag' ? MEDRAG_SYSTEM : COT_SYSTEM
  const methodInstructions = method === 'cot'
    ? methodSystem
    : `${methodSystem}\n\nFor this MedQA benchmark case, call ${toolName} exactly once before answering. Do not call any other tools. Use the returned ${method === 'imedrag' ? 'Query/Answer history' : 'retrieved documents'}, then answer the original multiple-choice question.`

  ctx.systemPrompt.section({
    name: 'huiyi:hc-rag-002-benchmark-policy',
    order: 500,
    text: methodInstructions,
  })

  // DSH exposes sampling through the native agent/request waterfall. Pin the
  // same greedy setting and output cap used by the upstream/direct comparison
  // arms without changing or replacing the DSH AgentLoop.
  ctx.on('agent/request', async (_payload, next) => ({
    ...await next(),
    temperature: 0,
    maxTokens: positiveInteger(process.env.HUIYI_RAG_BENCHMARK_MAX_OUTPUT_TOKENS, 1024),
  }))

  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: method === 'cot' ? [] : [toolName] })
  })

  if (method === 'cot') return

  ctx.tools.register(defineTool({
    name: toolName,
    description: method === 'imedrag'
      ? 'Run the pinned i-MedRAG follow-up query → retrieval → follow-up answer research procedure exactly once for one MedQA case. Returns its bounded Query/Answer history; it never chooses the final answer.'
      : 'Run one MedCPT retrieval over the prepared full MedText corpus. Returns source snippets only; it never chooses the final answer.',
    parameters: {
      question: { type: 'string', required: true },
      options: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          A: { type: 'string', required: true },
          B: { type: 'string', required: true },
          C: { type: 'string', required: true },
          D: { type: 'string', required: true },
        },
      },
    },
    output: {
      schema: method === 'imedrag' ? outputSchema : retrievalOutputSchema,
      render: (args, result) => [{ type: 'text', text: method === 'imedrag'
        ? renderFinalResearchContext(args, result)
        : renderFinalMedragContext(args, result) }],
    },
    async execute(args, exec) {
      const k = positiveInteger(process.env.HUIYI_RAG_BENCHMARK_K, 32)
      const timeoutMs = positiveInteger(process.env.HUIYI_RAG_BENCHMARK_TIMEOUT_MS, 180000)
      const controller = AbortSignal.timeout(timeoutMs)
      const signal = exec.signal ? AbortSignal.any([exec.signal, controller]) : controller
      const defaultUrl = method === 'imedrag' ? INTERNAL_RESEARCH_URL : INTERNAL_MEDRAG_URL
      const configuredUrl = method === 'imedrag'
        ? process.env.HUIYI_RAG_BENCHMARK_URL
        : process.env.HUIYI_RAG_MEDRAG_URL
      const url = localEndpoint(configuredUrl ?? defaultUrl)
      const canonicalOptions = Object.fromEntries(Object.entries(args.options).sort(([left], [right]) => left.localeCompare(right)))
      const caseId = createHash('sha256').update(JSON.stringify({ question: args.question, options: canonicalOptions })).digest('hex')
      const rounds = method === 'imedrag'
        ? positiveInteger(process.env.HUIYI_RAG_BENCHMARK_ROUNDS, 4)
        : undefined
      const queries = method === 'imedrag'
        ? positiveInteger(process.env.HUIYI_RAG_BENCHMARK_QUERIES, 3)
        : undefined
      const body = method === 'imedrag'
        ? {
            ...args,
            caseId,
            k,
            nRounds: rounds,
            nQueries: queries,
          }
        : { ...args, caseId, topK: k }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw new Error(`benchmark RAG endpoint returned HTTP ${response.status}`)
      const result = await response.json()
      appendMetadata(result, method)
      validateResearchResult(result, caseId, method, rounds)
      return result
    },
  }))
}

function renderFinalResearchContext(args, result) {
  const optionText = ['A', 'B', 'C', 'D'].map((key) => `${key}. ${args.options[key]}`).join('\n')
  return [
    result.history,
    `Here is the question:\n${args.question}\n\n${optionText}`,
    'Please first think step-by-step to analyze all the information in a section named Analysis (## Analysis). Then, please provide your answer choice in a section named Answer (## Answer).',
    FINAL_JSON_INSTRUCTION,
  ].filter(Boolean).join('\n\n')
}

function renderFinalMedragContext(args, result) {
  const optionText = ['A', 'B', 'C', 'D'].map((key) => `${key}. ${args.options[key]}`).join('\n')
  return `\nHere are the relevant documents:\n${result.context}\n\nHere is the question:\n${args.question}\n\nHere are the potential choices:\n${optionText}\n\nPlease think step-by-step and generate your output in json:\n`
}

function localEndpoint(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('benchmark research endpoint must use loopback HTTP')
  }
  return url.toString()
}

function positiveInteger(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('benchmark numeric configuration must be a positive integer')
  return value
}

function validateResearchResult(value, expectedCaseId, method, expectedRounds) {
  if (!value || typeof value !== 'object' || value.caseId !== expectedCaseId) {
    throw new Error('benchmark research endpoint returned an invalid result')
  }
  if (method === 'imedrag' && typeof value.history !== 'string') {
    throw new Error('i-MedRAG research endpoint omitted Query/Answer history')
  }
  if (method === 'imedrag' && value.roundsCompleted !== expectedRounds) {
    throw new Error('i-MedRAG research did not complete the frozen number of rounds')
  }
  if (method === 'medrag' && (typeof value.context !== 'string' || !Array.isArray(value.documents))) {
    throw new Error('MedRAG retrieval endpoint omitted its source documents')
  }
  if ('finalAnswer' in value || 'diagnosis' in value || 'userResponse' in value) {
    throw new Error('benchmark research endpoint must not return a final answer')
  }
}

function appendMetadata(result, method) {
  const traceFile = process.env.HUIYI_RAG_BENCHMARK_TRACE_FILE
  if (!traceFile) return
  mkdirSync(dirname(traceFile), { recursive: true })
  appendFileSync(traceFile, `${JSON.stringify({
    caseId: result.caseId,
    corpusVersion: result.corpusVersion,
    method,
    ...(result.promptVersion === undefined ? {} : { promptVersion: result.promptVersion }),
    ...(result.plannerModel === undefined ? {} : { plannerModel: result.plannerModel }),
    ...(result.roundsCompleted === undefined ? {} : { roundsCompleted: result.roundsCompleted }),
    ...(result.generatedQueries === undefined ? {} : { generatedQueries: result.generatedQueries }),
    ...(result.modelCalls === undefined ? {} : { modelCalls: result.modelCalls }),
    ...(result.retrievalCalls === undefined ? {} : { retrievalCalls: result.retrievalCalls }),
    ...(result.documents === undefined ? {} : { retrievedDocuments: result.documents.length }),
    ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
    ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    ...(result.retrievalLatencyMs === undefined ? {} : { retrievalLatencyMs: result.retrievalLatencyMs }),
    ...(result.modelLatencyMs === undefined ? {} : { modelLatencyMs: result.modelLatencyMs }),
    latencyMs: result.latencyMs,
    parseFailures: result.parseFailures,
  })}\n`, { encoding: 'utf8', mode: 0o600 })
}
