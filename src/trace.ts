import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export interface SessionTraceRecord {
  sessionId: string
  seq: number
  type: 'tool/call' | 'tool/result' | 'assistant/message' | 'turn/end'
  turn: number
  step?: number
  callId?: string
  toolName?: string
  isError?: boolean
  interrupted?: boolean
  reasonKind?: string
}

export function toSessionTraceRecord(session: Session, event: SessionEvent): SessionTraceRecord | undefined {
  const base = { sessionId: session.id, seq: event.seq }
  switch (event.type) {
    case 'tool/call':
      return {
        ...base,
        type: event.type,
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.callId,
        toolName: event.data.name,
      }
    case 'tool/result':
      return {
        ...base,
        type: event.type,
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.message.toolCallId,
        isError: event.data.message.isError ?? false,
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
  ctx.on('session/event', (session, event) => {
    const record = toSessionTraceRecord(session, event)
    if (record) console.info(`[huiyi-medharness] ${JSON.stringify(record)}`)
  })
}
