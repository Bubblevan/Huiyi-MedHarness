import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import fixtureData from '../fixtures/evidence.json' with { type: 'json' }
import { applyWithIdentity } from '../src/index.js'
import { searchMedicalEvidence, validateSearchInput, type EvidenceFixture } from '../src/evidence.js'
import { toSessionTraceRecord } from '../src/trace.js'
import type { EvidenceSet, MedicalEvidenceClientPort } from '../src/rag/contracts.js'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const fixtures = fixtureData as EvidenceFixture[]

describe('searchMedicalEvidence', () => {
  it('trims the query and defaults topK to 3', () => {
    const result = searchMedicalEvidence({ query: '  血压  ' }, fixtures)
    expect(result.query).toBe('血压')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.evidenceId).toBe('synthetic-blood-pressure-log')
  })

  it('honors an explicit topK', () => {
    const result = searchMedicalEvidence({ query: '记录', topK: 1 }, fixtures)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.rank).toBe(1)
  })

  it('rejects an empty query after trimming', () => {
    expect(() => validateSearchInput({ query: '  \n ' })).toThrow(/query must be a non-empty string/)
  })

  it('rejects topK below the supported range', () => {
    expect(() => validateSearchInput({ query: '血压', topK: 0 })).toThrow(/topK must be an integer/)
  })

  it('rejects topK above the supported range', () => {
    expect(() => validateSearchInput({ query: '血压', topK: 11 })).toThrow(/topK must be an integer/)
  })

  it('rejects a fractional topK', () => {
    expect(() => validateSearchInput({ query: '血压', topK: 1.5 })).toThrow(/topK must be an integer/)
  })

  it('returns deterministic ranking and stable evidence fields', () => {
    const first = searchMedicalEvidence({ query: '记录', topK: 10 }, fixtures)
    const second = searchMedicalEvidence({ query: '记录', topK: 10 }, fixtures)
    expect(first).toEqual(second)
    expect(first.hits.map(hit => hit.evidenceId)).toEqual([
      'synthetic-blood-pressure-log',
      'synthetic-symptom-followup',
    ])
    expect(first.hits.map(hit => hit.rank)).toEqual([1, 2])
    expect(first.hits[0]).toMatchObject({
      source: 'fixture://synthetic-blood-pressure-log',
      sourceType: 'synthetic_fixture',
    })
    expect(Object.keys(first.hits[0] ?? {}).sort()).toEqual([
      'evidenceId', 'rank', 'score', 'snippet', 'source', 'sourceType', 'title',
    ])
  })

  it('respects cancellation through the DSH execution signal', () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect(() => searchMedicalEvidence({ query: '血压' }, fixtures, controller.signal)).toThrow('cancelled')
  })
})

describe('session event observation', () => {
  const session = { id: 'session-fixture' } as Session

  it('records user and model route boundaries without their content', () => {
    const userEvent = {
      seq: 1,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] },
    } as unknown as SessionEvent
    const contextEvent = {
      seq: 2,
      type: 'request/context',
      data: { provider: 'local-qwen', model: 'local-qwen3-8b', contextWindow: 40960 },
    } as unknown as SessionEvent

    const records = [
      toSessionTraceRecord(session, userEvent),
      toSessionTraceRecord(session, contextEvent),
    ]
    expect(records).toEqual([
      { sessionId: 'session-fixture', seq: 1, type: 'user/message' },
      { sessionId: 'session-fixture', seq: 2, type: 'request/context', provider: 'local-qwen', model: 'local-qwen3-8b', contextWindow: 40960 },
    ])
    expect(JSON.stringify(records)).not.toContain('PRIVATE_PROMPT')
  })

  it('records only the evidence hit count from a canonical result', () => {
    const resultEvent = {
      seq: 3,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          toolCallId: 'call-empty',
          isError: false,
          content: [{ type: 'text', text: JSON.stringify({ query: 'PRIVATE_QUERY', hits: [] }) }],
        },
      },
    } as unknown as SessionEvent

    const record = toSessionTraceRecord(session, resultEvent)
    expect(record).toMatchObject({ type: 'tool/result', isError: false, hitCount: 0 })
    expect(JSON.stringify(record)).not.toContain('PRIVATE_QUERY')
  })

  it('keeps tool arguments and result content out of trace metadata', () => {
    const callEvent = {
      seq: 7,
      type: 'tool/call',
      data: {
        turn: 2,
        step: 1,
        callId: 'call-7',
        name: 'search_medical_evidence',
        arguments: '{"query":"PRIVATE_QUERY"}',
      },
    } as unknown as SessionEvent
    const resultEvent = {
      seq: 8,
      type: 'tool/result',
      data: {
        turn: 2,
        step: 1,
        message: {
          toolCallId: 'call-7',
          isError: false,
          content: [{ type: 'text', text: 'PRIVATE_EVIDENCE_SNIPPET' }],
        },
      },
    } as unknown as SessionEvent

    const callRecord = toSessionTraceRecord(session, callEvent)
    const resultRecord = toSessionTraceRecord(session, resultEvent)
    expect(callRecord).toMatchObject({ type: 'tool/call', toolName: 'search_medical_evidence', callId: 'call-7' })
    expect(resultRecord).toMatchObject({ type: 'tool/result', isError: false, callId: 'call-7' })
    expect(JSON.stringify([callRecord, resultRecord])).not.toContain('PRIVATE_QUERY')
    expect(JSON.stringify([callRecord, resultRecord])).not.toContain('PRIVATE_EVIDENCE_SNIPPET')
  })

  it('observes assistant settlement and turn boundaries without message text', () => {
    const assistantEvent = {
      seq: 9,
      type: 'assistant/message',
      data: { turn: 2, step: 2, interrupted: false, message: { content: 'PRIVATE_ANSWER' }, stream: [] },
    } as unknown as SessionEvent
    const endEvent = {
      seq: 10,
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'error', error: { message: 'PRIVATE_FAILURE' } } },
    } as unknown as SessionEvent

    const records = [
      toSessionTraceRecord(session, assistantEvent),
      toSessionTraceRecord(session, endEvent),
    ]
    expect(records).toEqual([
      { sessionId: 'session-fixture', seq: 9, type: 'assistant/message', turn: 2, step: 2, interrupted: false },
      { sessionId: 'session-fixture', seq: 10, type: 'turn/end', turn: 2, reasonKind: 'error' },
    ])
    expect(JSON.stringify(records)).not.toContain('PRIVATE_ANSWER')
    expect(JSON.stringify(records)).not.toContain('PRIVATE_FAILURE')
  })
})

describe('DSH native tool integration', () => {
  it('registers and executes through the DSH ToolRuntime with a structured result', async () => {
    const ctx = new Context()
    Object.defineProperty(ctx, 'systemPrompt', {
      value: { tools: () => undefined },
      configurable: true,
    })
    new ToolRuntime(ctx)
    const fixtureResult: EvidenceSet = {
      query: 'blood pressure',
      mode: 'single',
      hits: [{
        evidenceId: 'E1', rank: 1, title: 'Blood pressure', snippet: 'Source-backed snippet.',
        source: 'textbooks', sourceType: 'medical_reference', corpus: 'textbooks',
        sourceDocumentId: 'Anatomy_Gray', chunkId: '0', score: 0.91,
        retrievalQuery: 'private generated query', retrievalQueries: ['private generated query'],
        retrievalRound: 1, snippetTruncated: false,
      }],
      retrieval: {
        rounds: 1, generatedQueries: 0, uniqueDocuments: 1, candidateCount: 1,
        returnedEvidenceCount: 1, retrievalCalls: 1, plannerCalls: 0,
        retrievalLatencyMs: 1, plannerLatencyMs: 0, latencyMs: 2,
        estimatedContextTokens: 22, plannerModel: 'local-qwen-test', plannerPromptVersion: '',
        generatedQueryHashes: [], degraded: false,
      },
      corpusVersion: 'fixture-v1',
    }
    const client: MedicalEvidenceClientPort = {
      async search(request) { return { ...fixtureResult, query: request.query, mode: request.mode ?? 'single' } },
      async health() { return { status: 'ok' } },
    }

    try {
      applyWithIdentity(ctx, () => undefined, client)
      const toolSchema = ctx.tools.schemas().find(schema => schema.name === 'search_medical_evidence')
      expect(toolSchema).toBeDefined()
      expect(toolSchema?.parameters).toMatchObject({
        type: 'object',
        properties: { query: { type: 'string' }, mode: { type: 'string' }, topK: { type: 'integer' } },
        required: ['query'],
      })

      const traceLines: string[] = []
      const stdoutLines: string[] = []
      const originalError = console.error
      const originalInfo = console.info
      console.error = (...messages) => { traceLines.push(messages.map(String).join(' ')) }
      console.info = (...messages) => { stdoutLines.push(messages.map(String).join(' ')) }
      try {
        const session = { id: 'runtime-session' } as Session
        const events: unknown[] = [
          { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'search_medical_evidence', arguments: 'PRIVATE_QUERY' } },
          { seq: 2, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'PRIVATE_SNIPPET' }] } } },
          { seq: 3, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: 'PRIVATE_ANSWER' }, stream: [] } },
          { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ]
        for (const event of events) ctx.emit('session/event', session, event as SessionEvent)
      } finally {
        console.error = originalError
        console.info = originalInfo
      }
      expect(traceLines).toHaveLength(4)
      expect(stdoutLines).toEqual([])
      expect(traceLines.join('\n')).toContain('"type":"tool/call"')
      expect(traceLines.join('\n')).toContain('"type":"tool/result"')
      expect(traceLines.join('\n')).toContain('"type":"assistant/message"')
      expect(traceLines.join('\n')).toContain('"type":"turn/end"')
      expect(traceLines.join('\n')).not.toContain('PRIVATE_QUERY')
      expect(traceLines.join('\n')).not.toContain('PRIVATE_SNIPPET')
      expect(traceLines.join('\n')).not.toContain('PRIVATE_ANSWER')

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('f0-integration-call'),
        name: 'search_medical_evidence',
        arguments: { query: '血压', topK: 1 },
      })

      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected the DSH tool call to succeed')
      expect(result.value).toMatchObject({
        query: '血压', mode: 'single',
        hits: [{ evidenceId: 'E1', rank: 1, corpus: 'textbooks' }],
      })
      expect(result.content[0]?.type).toBe('text')
      expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('"evidenceId":"E1"')
      expect(result.content[0]?.type === 'text' ? result.content[0].text : '').not.toContain('private generated query')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
