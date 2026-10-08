#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { attributionHeaders, LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'

import { MemoryClient, applyMemoryOnly } from '../../../lib/index.js'
import { LOCOMO_QA_SYSTEM_PROMPT, renderLocomoMemoryContext } from './prompt.ts'
import { LocalQwenAdapter, LOCAL_QWEN_PROVIDER } from './local-qwen-adapter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const artifactRoot = resolve(process.env.HC_MEM_ARTIFACT_DIR ?? process.env.HC_MEM_003_ARTIFACT_DIR ?? process.env.HC_MEM_002_ARTIFACT_DIR ?? resolve(repoRoot, 'artifacts/hc-mem-002'))
const stateName = process.env.HC_MEM_STATE_NAME ?? 'frozen-state'
const stateManifestPath = resolve(process.env.HC_MEM_STATE_MANIFEST ?? resolve(artifactRoot, `${stateName}-manifest.json`))
const contractPath = resolve(process.env.HC_MEM_CONTRACT ?? resolve(here, 'manifest.json'))
const parsed = parseArgs({
  options: {
    dataset: { type: 'string', default: process.env.LOCOMO_DATASET ?? '/root/gpufree-share/data/locomo-mc10/raw/locomo10.json' },
    memoryUrl: { type: 'string', default: process.env.HUIYI_HEALTH_ENGINE_URL ?? 'http://127.0.0.1:8325' },
    modelUrl: { type: 'string', default: process.env.HUIYI_LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:8000/v1/chat/completions' },
    output: { type: 'string', default: resolve(artifactRoot, 'arm-c-dsh/predictions.jsonl') },
    trace: { type: 'string', default: resolve(artifactRoot, 'arm-c-dsh/trace-metadata.jsonl') },
    stateDir: { type: 'string', default: resolve(artifactRoot, 'arm-c-dsh/state') },
    limit: { type: 'string' },
    questionId: { type: 'string' },
    timeoutMs: { type: 'string', default: '600000' },
  },
  strict: true,
})
const options = parsed.values
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function filesUnder(directory, relative = '') {
  const result = []
  const current = relative ? resolve(directory, relative) : directory
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    const childPath = resolve(directory, childRelative)
    if (entry.isDirectory()) result.push(...filesUnder(directory, childRelative))
    else if (entry.isFile()) result.push({ path: childRelative, bytes: statSync(childPath).size, sha256: sha256File(childPath) })
    else throw new Error(`unexpected non-file in frozen memory state: ${childRelative}`)
  }
  return result
}

function verifyAllFullArmStates(manifest) {
  const copyManifest = JSON.parse(readFileSync(resolve(artifactRoot, `${stateName}-copies-manifest.json`), 'utf8'))
  if (copyManifest.source_manifest_sha256 !== sha256File(stateManifestPath)) {
    throw new Error('A/B/C copy manifest points to a different full-store manifest')
  }
  const arms = { A_UPSTREAM: 'arm-a-upstream', B_SIDECAR: 'arm-b-sidecar', C_DSH: 'arm-c-dsh' }
  const expectedFiles = manifest.files
    .map(item => ({ path: item.path, bytes: Number(item.bytes), sha256: item.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const treeHashes = new Set()
  for (const [arm, name] of Object.entries(arms)) {
    const relativeStateDir = `${name}/state`
    const entry = copyManifest.arms?.[arm]
    if (!entry || entry.relative_state_dir !== relativeStateDir) throw new Error(`missing or invalid frozen state copy for ${arm}`)
    if (JSON.stringify(entry.files) !== JSON.stringify(expectedFiles)) throw new Error(`${arm} copy manifest differs from full-store manifest`)
    const actual = filesUnder(resolve(artifactRoot, relativeStateDir))
    if (JSON.stringify(actual) !== JSON.stringify(expectedFiles)) throw new Error(`${arm} memory state is not byte-identical to the common frozen store`)
    treeHashes.add(entry.tree_sha256)
  }
  if (treeHashes.size !== 1) throw new Error('A/B/C memory state copies are not byte-identical')
}

function assertLoopbackUrl(value, label) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError(`${label} must use loopback HTTP`)
  }
}

const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
const qaMaxTokens = Number(process.env.LOCOMO_QA_MAX_TOKENS ?? contract.generation.maxTokens)
if (!Number.isInteger(qaMaxTokens) || qaMaxTokens < 1) throw new Error('LoCoMo contract must freeze a positive QA max token limit')
for (const model of [contract.models.qaGenerator, contract.models.embedding]) {
  const metadataPath = resolve(model.localPath, '.hfd/repo_metadata.json')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const metadataId = metadata.id ?? metadata.modelId
  if (metadataId !== model.id && !String(metadataId).endsWith(`/${model.id}`)) {
    throw new Error(`local model metadata identity differs from the benchmark contract: ${model.id}`)
  }
  if (metadata.sha !== model.sourceRevision) throw new Error(`local model revision differs from the benchmark contract: ${model.id}`)
}
const embeddingConfig = JSON.parse(readFileSync(resolve(contract.models.embedding.localPath, 'config.json'), 'utf8'))
if (Number(embeddingConfig.hidden_size) !== Number(contract.models.embedding.nativeOutputDimension)) {
  throw new Error('local embedding model dimension differs from the benchmark contract')
}
if (sha256File(options.dataset) !== contract.dataset.sha256) {
  throw new Error('LoCoMo dataset SHA256 does not match the frozen contract')
}
if ((process.env.HUIYI_LOCAL_LLM_MODEL ?? contract.models.qaGenerator.servedModelName) !== contract.models.qaGenerator.servedModelName) {
  throw new Error(`${contract.task} requires served model ${contract.models.qaGenerator.servedModelName}`)
}
const frozenStateManifest = JSON.parse(readFileSync(stateManifestPath, 'utf8'))
if (frozenStateManifest.dataset_sha256 !== contract.dataset.sha256
  || frozenStateManifest.ama_commit !== contract.amaCommit
  || frozenStateManifest.memory_model !== contract.models.memoryGenerator.id
  || frozenStateManifest.memory_api_model !== contract.models.memoryGenerator.servedModelName
  || frozenStateManifest.embedding_model !== contract.models.embedding.id
  || !frozenStateManifest.files?.length
  || !Array.isArray(frozenStateManifest.included_conversations)
  || !Array.isArray(frozenStateManifest.selected_session_keys)) {
  throw new Error('frozen memory state manifest does not match the dataset contract')
}
if (contract.requiredStoreScope === 'full'
  && (frozenStateManifest.partial !== false
    || frozenStateManifest.max_sessions !== null
    || frozenStateManifest.included_conversations.length !== contract.dataset.conversationCount
    || frozenStateManifest.conversation_count !== contract.dataset.conversationCount
    || frozenStateManifest.session_count !== contract.dataset.sessionCount
    || frozenStateManifest.dialogue_items !== contract.dataset.dialogueItemCount
    || frozenStateManifest.selected_session_keys.length !== contract.dataset.sessionCount)) {
  throw new Error('full LoCoMo evaluation requires a finalized non-partial memory store')
}
if (contract.requiredStoreScope === 'full') verifyAllFullArmStates(frozenStateManifest)
for (const entry of frozenStateManifest.files) {
  const path = resolve(options.stateDir, entry.path)
  if (path !== resolve(options.stateDir) && !path.startsWith(`${resolve(options.stateDir)}/`)) {
    throw new Error('frozen memory state manifest contains a path outside the store')
  }
  if (statSync(path).size !== entry.bytes || sha256File(path) !== entry.sha256) {
    throw new Error(`frozen memory state differs at ${entry.path}`)
  }
}
assertLoopbackUrl(options.memoryUrl, 'memory service URL')
assertLoopbackUrl(options.modelUrl, 'local model URL')
const embeddingProbeResponse = await fetch(new URL('/_internal/ama/embeddings', options.memoryUrl), {
  method: 'POST',
  headers: { authorization: 'Bearer local-only', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: contract.models.embedding.id,
    input: 'HC-MEM-003 local embedding contract probe',
  }),
  signal: AbortSignal.timeout(30_000),
})
if (!embeddingProbeResponse.ok) throw new Error(`local embedding endpoint returned HTTP ${embeddingProbeResponse.status}`)
const embeddingProbe = await embeddingProbeResponse.json()
const embeddingVector = embeddingProbe.data?.[0]?.embedding
if (embeddingProbe.model !== contract.models.embedding.id
  || !Array.isArray(embeddingVector)
  || embeddingVector.length !== Number(contract.models.embedding.amaDimension)
  || embeddingVector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
  throw new Error('local embedding endpoint differs from the frozen model/vector contract')
}
const modelListUrl = new URL(options.modelUrl)
if (!modelListUrl.pathname.endsWith('/chat/completions')) throw new Error('local model URL must end in /chat/completions')
modelListUrl.pathname = modelListUrl.pathname.slice(0, -'/chat/completions'.length) + '/models'
const versionUrl = new URL('/version', options.modelUrl)
const versionResponse = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) })
if (!versionResponse.ok) throw new Error(`local vLLM version endpoint returned HTTP ${versionResponse.status}`)
const versionPayload = await versionResponse.json()
if (versionPayload.version !== contract.inferenceEngine.version) {
  throw new Error('local vLLM version differs from the frozen benchmark contract')
}
const modelListResponse = await fetch(modelListUrl)
if (!modelListResponse.ok) throw new Error(`local model endpoint returned HTTP ${modelListResponse.status}`)
const modelList = await modelListResponse.json()
const servedModels = (modelList.data ?? []).filter(model => model.id === contract.models.qaGenerator.servedModelName)
if (servedModels.length !== 1 || servedModels[0].max_model_len !== contract.models.qaGenerator.contextWindow) {
  throw new Error('local model endpoint differs from the frozen served-model/context contract')
}
if (servedModels[0].root && resolve(servedModels[0].root) !== resolve(contract.models.qaGenerator.localPath)) {
  throw new Error('local model endpoint root differs from the frozen Qwen model path')
}
const dataset = JSON.parse(readFileSync(options.dataset, 'utf8'))
const allQuestions = []
for (let convIndex = 0; convIndex < dataset.length; convIndex += 1) {
  const row = dataset[convIndex]
  const convId = String(row.sample_id ?? `conversation-${String(convIndex + 1).padStart(2, '0')}`)
  for (let qaIndex = 0; qaIndex < (row.qa ?? []).length; qaIndex += 1) {
    const qa = row.qa[qaIndex]
    const category = Number(qa.category ?? 0)
    if (category === 5) continue
    allQuestions.push({
      conversation_id: convId,
      question_id: `${convId}:qa-${String(qaIndex + 1).padStart(4, '0')}`,
      category,
      question: String(qa.question ?? ''),
      gold_answer: String(qa.answer ?? ''),
      evidence: qa.evidence ?? [],
    })
  }
}
const allowedConversations = new Set(frozenStateManifest.included_conversations)
const scopedQuestions = allQuestions.filter(question => allowedConversations.has(question.conversation_id))
if (contract.requiredStoreScope === 'full') {
  const expectedConversations = dataset.map((row, index) => String(row.sample_id ?? `conversation-${String(index + 1).padStart(2, '0')}`))
  const categoryFiveCount = dataset.reduce((sum, row) => sum + (row.qa ?? []).filter(qa => Number(qa.category ?? 0) === 5).length, 0)
  const actualCategoryCounts = Object.fromEntries(['1', '2', '3', '4'].map(category => [category, allQuestions.filter(question => String(question.category) === category).length]))
  const expectedCategoryCounts = { '1': 282, '2': 321, '3': 96, '4': 841 }
  if (JSON.stringify(frozenStateManifest.included_conversations) !== JSON.stringify(expectedConversations)
    || allowedConversations.size !== 10 || scopedQuestions.length !== 1540
    || dataset.length !== 10 || dataset.reduce((sum, row) => sum + (row.qa ?? []).length, 0) !== 1986
    || categoryFiveCount !== 446 || JSON.stringify(actualCategoryCounts) !== JSON.stringify(expectedCategoryCounts)) {
    throw new Error('full LoCoMo evaluation requires all 10 conversations in dataset order and 1540 category-5-excluded questions')
  }
}
let questions = options.limit === undefined ? scopedQuestions : scopedQuestions.slice(0, Math.max(0, Number(options.limit)))
if (options.questionId !== undefined) {
  questions = questions.filter(question => question.question_id === options.questionId)
  if (questions.length !== 1) throw new Error(`question id is outside the selected frozen scope: ${options.questionId}`)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalSnapshot(snapshot) {
  const items = snapshot.items.map(item => ({
    kind: item.kind,
    content: item.content,
    timestamp: item.timestamp ?? null,
  }))
  const compact = JSON.stringify(items)
  return {
    hash: sha256(compact),
    retrievedItems: snapshot.items.map((item, index) => ({
      kind: items[index].kind,
      timestamp: items[index].timestamp,
      content_sha256: sha256(items[index].content),
      ...(typeof item.sourceId === 'string' && item.sourceId ? { source_id: item.sourceId } : {}),
    })),
    retrievedCount: items.length,
    retrievedKinds: Object.fromEntries(['raw', 'fact', 'episode'].map(kind => [kind, items.filter(item => item.kind === kind).length])),
  }
}

function messageText(content) {
  return (content ?? []).flatMap(block => block?.type === 'text' ? [block.text] : []).join('\n').trim()
}

function parseAnswer(raw) {
  try {
    const value = JSON.parse(raw)
    if (typeof value?.answer !== 'string') return { answer: '', evidence: [], parseError: 'MissingAnswerField' }
    const evidence = Array.isArray(value.evidence)
      ? value.evidence.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
      : typeof value.evidence === 'string' && value.evidence.trim() ? [value.evidence.trim()] : []
    return { answer: value.answer.trim(), evidence, parseError: null }
  } catch {
    return { answer: '', evidence: [], parseError: 'InvalidJson' }
  }
}

function citationRefValidity(providedItems, parsed) {
  const provided = [...new Set(providedItems.map(item => item.sourceId).filter(value => typeof value === 'string' && value))].sort()
  const referenced = parsed.evidence ?? []
  const providedSet = new Set(provided)
  const invalid = referenced.filter(value => !providedSet.has(value))
  const validCount = referenced.length - invalid.length
  return {
    provided_ref_count: provided.length,
    reference_count: referenced.length,
    valid_reference_count: validCount,
    invalid_reference_count: invalid.length,
    referenced_ids: referenced,
    invalid_ids: invalid,
    validity_rate: referenced.length ? validCount / referenced.length : null,
    has_invalid_reference: invalid.length > 0,
  }
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const resolvedPath = resolve(path)
  const privateOutput = resolvedPath === artifactRoot || resolvedPath.startsWith(`${artifactRoot}/`)
  if (privateOutput) chmodSync(dirname(path), 0o700)
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (privateOutput) chmodSync(path, 0o600)
}

function loadCompleted(path) {
  try {
    return new Set(readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).question_id))
  } catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw error
  }
}

const evaluationRunId = randomUUID()

function sessionIdFor(questionId) {
  return `locomo-${evaluationRunId.slice(0, 8)}-${sha256(questionId).slice(0, 24)}`
}

class RecordingMemoryClient extends MemoryClient {
  constructor(config, snapshots) {
    super(config)
    this.snapshots = snapshots
  }

  async recall(request, requestOptions) {
    const snapshot = await super.recall(request, requestOptions)
    this.snapshots.set(request.sessionId, canonicalSnapshot(snapshot))
    return snapshot
  }
}

const ctx = new Context()
const sessionMetrics = new Map()
const snapshots = new Map()
const memoryRecords = []
const modelAdapter = new LocalQwenAdapter({ baseUrl: options.modelUrl, timeoutMs: Number(options.timeoutMs) })

new TypertRegistry(ctx)
new SessionStore(ctx)
new SessionProjectionRegistry(ctx)
new AgentRegistry(ctx)
new LlmRuntime(ctx)
new SystemPrompt(ctx, { includeHarnessIdentity: false })
new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 1 })
ctx.llm.registerAdapter([LOCAL_QWEN_PROVIDER], modelAdapter)
new AgentLoop(ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }))
ctx.systemPrompt.section({ name: 'huiyi:locomo-parity-qa', order: 250, text: LOCOMO_QA_SYSTEM_PROMPT })
ctx.on('agent/request', async (_request, next) => ({
  ...(await next()),
  temperature: 0,
}))

const memoryClient = new RecordingMemoryClient({ baseUrl: options.memoryUrl, recallTimeoutMs: Number(options.timeoutMs) }, snapshots)
await memoryClient.health()
applyMemoryOnly(
  ctx,
  agent => sessionMetrics.get(agent.id)?.userId,
  {
    automaticStrongRetrieve: true,
    readOnly: true,
    renderContext: (snapshot, query) => renderLocomoMemoryContext(snapshot, query),
  },
  {
    client: memoryClient,
    trace: { record: record => memoryRecords.push(record) },
  },
)

let currentSession = null
const disposeSessionEvents = ctx.on('session/event', (session, event) => {
  if (session.id !== currentSession) return
  const metrics = sessionMetrics.get(session.id)
  if (!metrics) return
  if (event.type === 'turn/start') {
    metrics.turnStartedAt = event.time
    metrics.turn = event.data.turn
  } else if (event.type === 'step/start') {
    metrics.stepCount += 1
  } else if (event.type === 'assistant/message') {
    metrics.assistantText = messageText(event.data.message.content)
    metrics.assistantEventCount += 1
  } else if (event.type === 'turn/end') {
    metrics.turnEndedAt = event.time
    metrics.turnReason = event.data.reason.kind
  }
})

const completed = loadCompleted(options.output)
const todo = questions.filter(question => !completed.has(question.question_id))
try {
  for (const question of todo) {
    const sessionId = sessionIdFor(question.question_id)
    const userId = `locomo:${question.conversation_id}`
    const metrics = { userId, stepCount: 0, assistantEventCount: 0 }
    sessionMetrics.set(sessionId, metrics)
    currentSession = sessionId
    console.log(`Arm C ${question.question_id} (${question.category})`)

    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: {
        provider: LOCAL_QWEN_PROVIDER,
        model: process.env.HUIYI_LOCAL_LLM_MODEL ?? contract.models.qaGenerator.servedModelName,
        maxTokens: qaMaxTokens,
      },
    })
    const startedAt = performance.now()
    handle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: question.question }],
    }))
    await handle.agent.whenIdle()
    const endToEndMs = Math.max(0, performance.now() - startedAt)
    const turnReason = metrics.turnReason
    const traceRows = memoryRecords.filter(record => record.sessionId === sessionId && record.turn === metrics.turn)
    const recallTrace = traceRows.find(record => record.operation === 'automatic_recall')
    const commitTrace = traceRows.find(record => record.operation === 'commit')
    const snapshot = snapshots.get(sessionId)
    const modelRequests = modelAdapter.metrics(sessionId)
    const firstModel = modelRequests[0]
    if (turnReason !== 'completed' && turnReason !== 'max-tokens') {
      throw new Error(`DSH turn did not complete (${turnReason ?? 'no turn/end'}) for ${question.question_id}`)
    }
    if (turnReason === 'completed' && !metrics.assistantText) throw new Error(`DSH turn produced no assistant text for ${question.question_id}`)
    if (traceRows.filter(row => row.operation === 'automatic_recall').length !== 1 || recallTrace?.status !== 'completed' || !snapshot) {
      throw new Error(`DSH question did not produce exactly one completed automatic recall for ${question.question_id}`)
    }
    if (commitTrace?.errorClass !== 'evaluation_read_only'
      && !(turnReason === 'max-tokens' && commitTrace?.errorClass === 'turn_max-tokens')) {
      throw new Error(`DSH question was not protected by the read-only memory profile for ${question.question_id}`)
    }
    if (metrics.stepCount !== 1 || modelRequests.length !== 1 || ctx.tools.schemas().length !== 0) {
      throw new Error(`unexpected DSH tool or multi-step activity in the read-only parity profile for ${question.question_id}`)
    }

    const parsedAnswer = turnReason === 'completed'
      ? parseAnswer(metrics.assistantText)
      : { answer: '', evidence: [], parseError: 'TurnMaxTokens' }
    const citationRefs = citationRefValidity(
      snapshot.retrievedItems.map(item => ({ sourceId: item.source_id })),
      parsedAnswer,
    )
    const record = {
      question_id: question.question_id,
      conversation_id: question.conversation_id,
      category: question.category,
      question: question.question,
      gold_answer: question.gold_answer,
      response: parsedAnswer.answer,
      response_raw: metrics.assistantText,
      parse_error: parsedAnswer.parseError,
      citation_ref_validity: citationRefs,
      turn_reason: turnReason,
      evidence: question.evidence,
      profile: 'locomo-parity',
      arm: 'C_DSH',
      model: contract.models.qaGenerator.id,
      api_model: contract.models.qaGenerator.servedModelName,
      memory_model: contract.models.memoryGenerator.id,
      memory_api_model: contract.models.memoryGenerator.servedModelName,
      temperature: 0,
      seed: Number(contract.generation.randomSeed ?? 0),
      qa_max_tokens: qaMaxTokens,
      top_k: 10,
      turn_retrieve: 3,
      strong_retrieve: true,
      read_only: true,
      store_scope_partial: Boolean(frozenStateManifest.partial),
      store_scope_max_sessions: frozenStateManifest.max_sessions ?? null,
      session_id: sessionId,
      evaluation_run_id: evaluationRunId,
      model_step_count: metrics.stepCount,
      tool_call_count: 0,
      memory_write_count: 0,
      assistant_event_count: metrics.assistantEventCount,
      automatic_recall_count: traceRows.filter(row => row.operation === 'automatic_recall').length,
      recall_status: recallTrace?.status ?? 'missing',
      commit_status: commitTrace?.errorClass ?? commitTrace?.status ?? 'missing',
      memory_trace: traceRows,
      snapshot_hash: snapshot?.hash ?? null,
      retrieved_items: snapshot?.retrievedItems ?? [],
      retrieved_count: snapshot?.retrievedCount ?? 0,
      retrieved_kinds: snapshot?.retrievedKinds ?? { raw: 0, fact: 0, episode: 0 },
      ama_llm_call_count: recallTrace?.amaLlmCallCount ?? null,
      ama_prompt_tokens: recallTrace?.amaPromptTokens ?? null,
      ama_completion_tokens: recallTrace?.amaCompletionTokens ?? null,
      ama_usage_report_count: recallTrace?.amaUsageReportCount ?? null,
      snapshot_token_estimate_utf8: recallTrace?.tokenEstimate ?? null,
      qa_usage: firstModel ? {
        prompt_tokens: firstModel.promptTokens ?? null,
        completion_tokens: firstModel.completionTokens ?? null,
        total_tokens: firstModel.totalTokens ?? null,
      } : null,
      latency_ms: {
        recall: recallTrace?.latencyMs ?? null,
        dsh_pre_model: metrics.turnStartedAt !== undefined && firstModel ? Math.max(0, firstModel.requestStartedAt - metrics.turnStartedAt) : null,
        answer_generation: firstModel?.durationMs ?? null,
        first_token: firstModel?.firstTokenAt !== undefined ? firstModel.firstTokenAt - firstModel.requestStartedAt : null,
        total_dsh_turn: metrics.turnStartedAt !== undefined && metrics.turnEndedAt !== undefined ? Math.max(0, metrics.turnEndedAt - metrics.turnStartedAt) : null,
        end_to_end_wall: endToEndMs,
      },
    }
    appendJsonl(options.output, record)
    appendJsonl(options.trace, {
      question_id: question.question_id,
      conversation_id: question.conversation_id,
      category: question.category,
      session_id: sessionId,
      turn: metrics.turn ?? null,
      step_count: metrics.stepCount,
      tool_call_count: record.tool_call_count,
      memory_write_count: record.memory_write_count,
      model_request_count: modelRequests.length,
      automatic_recall_count: record.automatic_recall_count,
      recall_status: record.recall_status,
      commit_status: record.commit_status,
      turn_reason: record.turn_reason,
      parse_error: record.parse_error,
      citation_reference_count: citationRefs.reference_count,
      citation_valid_reference_count: citationRefs.valid_reference_count,
      citation_invalid_reference_count: citationRefs.invalid_reference_count,
      snapshot_hash: record.snapshot_hash,
      retrieved_count: record.retrieved_count,
      retrieved_kinds: record.retrieved_kinds,
      ama_llm_call_count: record.ama_llm_call_count,
      ama_prompt_tokens: record.ama_prompt_tokens,
      ama_completion_tokens: record.ama_completion_tokens,
      qa_usage: record.qa_usage,
      latency_ms: record.latency_ms,
      memory_trace: traceRows,
    })
    await handle.dispose()
    sessionMetrics.delete(sessionId)
    snapshots.delete(sessionId)
    memoryRecords.splice(0, memoryRecords.length, ...memoryRecords.filter(row => row.sessionId !== sessionId))
    currentSession = null
  }
} finally {
  disposeSessionEvents()
  await ctx.fiber.dispose()
}

if (contract.requiredStoreScope === 'full') verifyAllFullArmStates(frozenStateManifest)
console.log(`Arm C complete: ${loadCompleted(options.output).size}/${questions.length} scoped questions; store_partial=${Boolean(frozenStateManifest.partial)}; debug_limit=${options.limit !== undefined}`)
