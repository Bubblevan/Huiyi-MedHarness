import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ragTraceMetadata } from './rag/trace.js'

export interface SessionTraceRecord {
  sessionId: string
  seq: number
  time?: number
  type: 'turn/start' | 'user/message' | 'request/context' | 'tool/call' | 'tool/result' | 'assistant/message' | 'turn/end'
  turn?: number
  step?: number
  callId?: string
  toolName?: string
  provider?: string
  model?: string
  contextWindow?: number
  hitCount?: number
  ragMode?: 'single' | 'iterative'
  retrievalRounds?: number
  generatedQueryCount?: number
  uniqueEvidenceCount?: number
  candidateCount?: number
  returnedEvidenceCount?: number
  retrievalCalls?: number
  plannerCalls?: number
  retrievalLatencyMs?: number
  plannerLatencyMs?: number
  ragLatencyMs?: number
  estimatedContextTokens?: number
  corpusVersion?: string
  plannerModel?: string
  plannerPromptVersion?: string
  plannerInputTokens?: number
  plannerOutputTokens?: number
  generatedQueryHashes?: string[]
  degraded?: boolean
  degradedErrorClass?: string
  isError?: boolean
  interrupted?: boolean
  reasonKind?: string
}

function evidenceHitCount(content: unknown): number | undefined {
  if (!Array.isArray(content)) return undefined

  for (const block of content) {
    if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') continue
    try {
      const value: unknown = JSON.parse(block.text)
      if (typeof value === 'object' && value !== null && 'query' in value && typeof value.query === 'string' && 'hits' in value && Array.isArray(value.hits)) {
        return value.hits.length
      }
    } catch {
      // Other tools may render non-JSON text; only the count is recorded when
      // the canonical EvidenceResult envelope is present.
    }
  }
  return undefined
}

export function toSessionTraceRecord(session: Session, event: SessionEvent): SessionTraceRecord | undefined {
  const base = {
    sessionId: session.id,
    seq: event.seq,
    ...typeof event.time === 'number' ? { time: event.time } : {},
  }
  switch (event.type) {
    case 'turn/start':
      return { ...base, type: event.type, turn: event.data.turn }
    case 'user/message':
      return { ...base, type: event.type }
    case 'request/context':
      return {
        ...base,
        type: event.type,
        provider: event.data.provider,
        model: event.data.model,
        ...event.data.contextWindow === undefined ? {} : { contextWindow: event.data.contextWindow },
      }
    case 'tool/call':
      return {
        ...base,
        type: event.type,
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.callId,
        toolName: event.data.name,
      }
    case 'tool/result': {
      const hitCount = evidenceHitCount(event.data.message.content)
      return {
        ...base,
        type: event.type,
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.message.toolCallId,
        isError: event.data.message.isError ?? false,
        ...hitCount === undefined ? {} : { hitCount },
        ...ragTraceMetadata(event.data.message.content),
      }
    }
    case 'assistant/message':
      return {
        ...base,
        type: event.type,
        turn: event.data.turn,
        step: event.data.step,
        interrupted: event.data.interrupted === true,
      }
    case 'turn/end':
      return {
        ...base,
        type: event.type,
        turn: event.data.turn,
        reasonKind: event.data.reason.kind,
      }
    default:
      return undefined
  }
}

export function observeSessionEvents(ctx: Context): void {
  const traceFile = process.env.HUIYI_SESSION_TRACE_FILE
  ctx.on('session/event', (session, event) => {
    const record = toSessionTraceRecord(session, event)
    if (!record) return

    const line = JSON.stringify(record)
    if (traceFile) {
      try {
        mkdirSync(dirname(traceFile), { recursive: true })
        appendFileSync(traceFile, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch (error: unknown) {
        const name = error instanceof Error ? error.name : 'UnknownError'
        console.error(`[huiyi-medharness] metadata trace write failed (${name})`)
      }
    }
    // Keep stdout available to DSH apps such as ACP, whose stdio is a wire protocol.
    console.error(`[huiyi-medharness] ${line}`)
  })
}
