#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'

import { applyWithIdentity } from '../../lib/index.js'
import { MemoryClient } from '../../lib/memory/client.js'
import { RagClient } from '../../lib/rag/client.js'
import { MetadataCollaborationTrace } from '../../lib/collaboration/trace.js'
import { renderEvidenceSet } from '../../lib/rag/render.js'
import { toSessionTraceRecord } from '../../lib/trace.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const parsed = parseArgs({
  options: {
    input: { type: 'string', default: '/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic/questions.jsonl' },
    output: { type: 'string', default: '/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic/predictions.jsonl' },
    sessionTrace: { type: 'string', default: '/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic/session-metadata.jsonl' },
    collaborationTrace: { type: 'string', default: '/root/gpufree-data/repro/hc-ma-002/medqa-dev-diagnostic/collaboration-metadata.jsonl' },
    arm: { type: 'string', default: 'both' },
    caseId: { type: 'string' },
  },
  strict: true,
})
const options = parsed.values
if (!['both', 'single', 'adaptive'].includes(options.arm)) throw new Error('--arm must be both, single, or adaptive')

const inputPath = resolve(options.input)
const outputPath = resolve(options.output)
const sessionTracePath = resolve(options.sessionTrace)
const collaborationTracePath = resolve(options.collaborationTrace)
const insideRepo = path => path === repoRoot || path.startsWith(`${repoRoot}/`)
if ([inputPath, outputPath, sessionTracePath, collaborationTracePath].some(insideRepo)) {
  throw new Error('questions and runtime traces must stay outside the Git worktree')
}
const frozenCases = readFileSync(inputPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
  const value = JSON.parse(line)
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'id,options,question'
    || typeof value.id !== 'string' || !value.id.startsWith('medqa-dev-')
    || typeof value.question !== 'string' || !value.question.trim()
    || typeof value.options !== 'object' || value.options === null || Array.isArray(value.options)
    || Object.keys(value.options).sort().join(',') !== 'A,B,C,D,E') {
    throw new Error(`input case ${index} is not a gold-free dev question/options row`)
  }
  return value
})
if (frozenCases.length !== 4) throw new Error('HC-MA-002 local diagnostic requires the frozen four-case projection')
const cases = options.caseId ? frozenCases.filter(item => item.id === options.caseId) : frozenCases
if (options.caseId && cases.length !== 1) throw new Error('--case-id must identify one row from the frozen diagnostic projection')

const providerName = 'hc-ma-002-local-qwen'
const modelId = 'Qwen/Qwen3-8B'
const contextWindow = 40960
process.env.HUIYI_LOCAL_QWEN_API_KEY = 'local-only'
process.env.HUIYI_HEALTH_ENGINE_URL = 'http://127.0.0.1:8322'
process.env.HUIYI_MEMORY_USER_ID = 'hc-ma-002-synthetic-diagnostic'

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function messageText(content) {
  return (content ?? []).flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
}

function parseChoice(text) {
  try {
    const value = JSON.parse(text)
    if (typeof value?.answer === 'string' && /^[A-E]$/i.test(value.answer.trim())) return value.answer.trim().toUpperCase()
  } catch {
    // The raw response is deliberately not retained when parsing fails.
  }
  const matches = [...text.matchAll(/\b(?:answer|choice)\s*(?:is|:|=)?\s*([A-E])\b/gi)]
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : null
}

function questionText(item) {
  return `${item.question}\n\nOptions\n${Object.entries(item.options).map(([letter, option]) => `${letter}. ${option}`).join('\n')}`
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 })
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function compose(arm, queryHash, queryText, sessionMetadata, collaborationRecords, memoryRecords, evidenceMetrics) {
  const ctx = new Context()
  let rootHandle
  const sessionId = `hcma2-${arm}-${randomUUID()}`
  const sessionMetrics = { turnReason: undefined, assistantText: '', toolCalls: [], endTime: undefined, startTime: undefined, steps: 0 }
  const memoryTrace = { record(record) { memoryRecords.push({ caseHash: queryHash, arm, ...record }) } }
  const evidence = new RagClient()
  const evidenceCache = new Map()
  const evidenceClient = {
    async search(request, requestOptions) {
      const cacheKey = JSON.stringify([request.query.trim(), request.mode ?? null, request.topK ?? null])
      let resultPromise = evidenceCache.get(cacheKey)
      if (!resultPromise) {
        resultPromise = evidence.search(request, requestOptions).then(result => {
          evidenceMetrics.calls += 1
          evidenceMetrics.hitCount += result.hits.length
          evidenceMetrics.degraded ||= result.retrieval.degraded
          return result
        })
        evidenceCache.set(cacheKey, resultPromise)
      }
      return resultPromise
    },
    health: options => evidence.health(options),
  }
  let caseEvidence
  try {
    caseEvidence = await evidenceClient.search({ query: queryText, mode: 'single', topK: 5 }, { signal: new AbortController().signal })
  } catch {
    evidenceMetrics.degraded = true
  }

  try {
    new TypertRegistry(ctx)
    new SessionStore(ctx)
    new SessionProjectionRegistry(ctx)
    new AgentRegistry(ctx)
    new LlmRuntime(ctx)
    new SystemPrompt(ctx, { includeHarnessIdentity: false })
    new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 1 })
    new AgentLoop(ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }))
    if (arm === 'adaptive') {
      new SubagentRuntime(ctx, SubagentRuntime.Config({ maxDepth: 1, maxActiveSubagents: 8 }))
      const spawnPlugin = Object.assign(Spawn.apply, { inject: Spawn.inject, Config: Spawn.Config })
      await ctx.plugin(spawnPlugin, { providerName: 'spawn' })
    }

    const piAiPlugin = Object.assign(PiAi.apply, { inject: PiAi.inject, Config: PiAi.Config })
    await ctx.plugin(piAiPlugin, {
      providers: {
        [providerName]: {
          displayName: 'Local Qwen for HC-MA-002',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:8000/v1',
          apiKeyEnv: 'HUIYI_LOCAL_QWEN_API_KEY',
          models: [{ id: modelId, name: modelId, contextWindow }],
        },
      },
    })
    ctx.on('agent/request', async (_request, next) => ({ ...(await next()), temperature: 0 }))

    const trace = new MetadataCollaborationTrace(record => collaborationRecords.push({ caseHash: queryHash, arm, ...record }))
    applyWithIdentity(
      ctx,
      () => process.env.HUIYI_MEMORY_USER_ID,
      evidenceClient,
      {
        memory: { readOnly: true },
        memoryClient: new MemoryClient(),
        memoryTrace,
        collaborationTrace: trace,
      },
    )

    const diagnosticPrompt = arm === 'adaptive'
      ? 'Answer the current multiple-choice medical question using the provided question, options, patient-memory snapshot, and External Evidence Snapshot. Before deciding, call consult_clinical_team exactly once. The collaboration result is advisory. Do not call search_medical_evidence separately; use the supplied snapshot. If the evidence snapshot is empty, continue without claiming retrieved support. Return only JSON with an answer field containing one option letter A, B, C, D, or E. Do not include analysis or hidden reasoning.'
      : 'Answer the current multiple-choice medical question using the provided question, options, patient-memory snapshot, and External Evidence Snapshot. Do not call search_medical_evidence separately; use the supplied snapshot. If the evidence snapshot is empty, continue without claiming retrieved support. Return only JSON with an answer field containing one option letter A, B, C, D, or E. Do not include analysis or hidden reasoning.'

    const disposeEvents = ctx.on('session/event', (session, event) => {
      const record = toSessionTraceRecord(session, event)
      if (record) sessionMetadata.push({ caseHash: queryHash, arm, ...record })
      if (session.id !== sessionId) return
      if (event.type === 'turn/start') sessionMetrics.startTime = event.time
      else if (event.type === 'step/start') sessionMetrics.steps += 1
      else if (event.type === 'tool/call') sessionMetrics.toolCalls.push(event.data.name)
      else if (event.type === 'assistant/message' && event.data.interrupted !== true) {
        sessionMetrics.assistantText = messageText(event.data.message.content)
      } else if (event.type === 'turn/end') {
        sessionMetrics.turnReason = event.data.reason.kind
        sessionMetrics.endTime = event.time
      }
    })

    rootHandle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: providerName, model: modelId, maxTokens: 768 },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({
          name: 'hc-ma-002-diagnostic-evidence',
          order: 240,
          text: caseEvidence
            ? `External Evidence Snapshot\n${renderEvidenceSet(caseEvidence)}`
            : 'External Evidence Snapshot\nRAG retrieval is unavailable; no retrieved evidence is available for this case.',
        })
        agentCtx.systemPrompt.section({
          name: 'hc-ma-002-medqa-diagnostic',
          order: 260,
          text: diagnosticPrompt,
        })
      },
    })
    const startedAt = performance.now()
    rootHandle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: queryText }],
    }))
    await rootHandle.agent.whenIdle()
    const wallLatencyMs = Math.max(0, performance.now() - startedAt)
    disposeEvents()

    const collab = collaborationRecords.filter(record => record.caseHash === queryHash && record.arm === arm)
    const childRecords = collab.filter(record => record.event === 'child')
    const completedSpecialists = childRecords.filter(record => record.task === 'specialist-analysis' && record.status === 'completed').length
    const finalComplexity = childRecords.at(-1)?.complexity ?? 'basic'
    return {
      result: {
        sessionId,
        arm,
        turnReason: sessionMetrics.turnReason ?? 'missing',
        choice: parseChoice(sessionMetrics.assistantText),
        toolCalls: [...sessionMetrics.toolCalls],
        rootStepCount: sessionMetrics.steps,
        childRuns: childRecords.length,
        failedChildRuns: childRecords.filter(record => record.status === 'failed').length,
        specialistRuns: childRecords.filter(record => record.task === 'specialist-analysis').length,
        specialistFindingsCompleted: completedSpecialists,
        moderatorRuns: childRecords.filter(record => record.task === 'moderator').length,
        complexity: finalComplexity,
        wallLatencyMs,
        dshTurnLatencyMs: sessionMetrics.startTime !== undefined && sessionMetrics.endTime !== undefined
          ? Math.max(0, sessionMetrics.endTime - sessionMetrics.startTime)
          : null,
        memory: memoryRecords.filter(record => record.caseHash === queryHash && record.arm === arm),
        evidence: { ...evidenceMetrics },
      },
    }
  } finally {
    await rootHandle?.dispose()
    await ctx.fiber.dispose()
  }
}

const selectedArms = options.arm === 'both' ? ['single', 'adaptive'] : [options.arm]
const outputRows = []
const sessionRows = []
const collaborationRows = []
const memoryRows = []
const safeMetrics = []
mkdirSync(dirname(outputPath), { recursive: true })
mkdirSync(dirname(sessionTracePath), { recursive: true })
mkdirSync(dirname(collaborationTracePath), { recursive: true })
writeFileSync(outputPath, '', { mode: 0o600 })
writeFileSync(sessionTracePath, '', { mode: 0o600 })
writeFileSync(collaborationTracePath, '', { mode: 0o600 })

for (const item of cases) {
  const query = questionText(item)
  const queryHash = hash(query)
  for (const arm of selectedArms) {
    const evidenceMetrics = { calls: 0, hitCount: 0, degraded: false }
    const run = await compose(arm, queryHash, query, sessionRows, collaborationRows, memoryRows, evidenceMetrics)
    const result = run.result
    const row = {
      id: item.id,
      arm,
      caseHash: queryHash,
      sessionId: result.sessionId,
      turnReason: result.turnReason,
      choice: result.choice,
      toolCalls: result.toolCalls,
      rootStepCount: result.rootStepCount,
      childRuns: result.childRuns,
      failedChildRuns: result.failedChildRuns,
      specialistRuns: result.specialistRuns,
      specialistFindingsCompleted: result.specialistFindingsCompleted,
      moderatorRuns: result.moderatorRuns,
      complexity: result.complexity,
      wallLatencyMs: result.wallLatencyMs,
      dshTurnLatencyMs: result.dshTurnLatencyMs,
      memory: result.memory.map(record => ({
        operation: record.operation, status: record.status, itemCount: record.itemCount ?? null,
        errorClass: record.errorClass ?? null, latencyMs: record.latencyMs ?? null,
      })),
      evidence: result.evidence,
    }
    outputRows.push(row)
    safeMetrics.push(row)
    appendJsonl(outputPath, row)
    process.stdout.write(`${item.id} ${arm}: ${row.turnReason}; choice=${row.choice ?? 'unparsed'}; childRuns=${row.childRuns}; latencyMs=${Math.round(row.wallLatencyMs)}\n`)
  }
}

writeJsonl(sessionTracePath, sessionRows)
writeJsonl(collaborationTracePath, collaborationRows)
const predictionSha256 = hash(readFileSync(outputPath))
const metadata = {
  task: 'HC-MA-002',
  dshRuntime: '@deepseek-ai/deepseek-harness 0.2.1-alpha.1',
  localModel: { id: modelId, path: '/root/gpufree-share/data/Qwen3-8B', contextWindow, provider: providerName },
  arms: selectedArms,
  input: { path: inputPath, sha256: hash(readFileSync(inputPath)), fields: ['id', 'question', 'options'], rowCount: frozenCases.length, executedRowCount: cases.length },
  predictions: { path: outputPath, sha256: predictionSha256, rows: outputRows.length, containsRawResponses: false },
  traces: {
    session: { path: sessionTracePath, rows: sessionRows.length, metadataOnly: true },
    collaboration: { path: collaborationTracePath, rows: collaborationRows.length, metadataOnly: true },
  },
  node: process.version,
  pnpm: '11.7.0',
  gpuInference: true,
  testLabelsRead: false,
  perCase: safeMetrics.map(({ id, arm, turnReason, choice, caseHash, childRuns, failedChildRuns, specialistRuns, specialistFindingsCompleted, moderatorRuns, complexity, evidence, memory }) => ({
    id, arm, turnReason, choice, caseHash, childRuns, failedChildRuns, specialistRuns,
    specialistFindingsCompleted, moderatorRuns, complexity, evidence,
    memory: memory.map(({ operation, status, itemCount, errorClass }) => ({ operation, status, itemCount, errorClass })),
  })),
}
const runMetadataPath = resolve(dirname(outputPath), 'run-metadata.json')
writeFileSync(runMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`Prediction SHA256: ${predictionSha256}\n`)
