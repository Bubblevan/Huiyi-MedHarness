import { createHash } from 'node:crypto'
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm'

const PROVIDER = 'huiyi-locomo-local'
const MODEL = process.env.HUIYI_LOCAL_LLM_MODEL ?? 'Qwen3-8B'
const CONTEXT_WINDOW = 16384

function textFromMessage(message) {
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(block => {
    if (block?.type === 'text' || block?.type === 'reasoning') return block.text
    return ''
  }).filter(Boolean).join('\n')
}

function parseData(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return undefined
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return data === '[DONE]' ? null : undefined
  return JSON.parse(data)
}

export class LocalQwenAdapter extends LlmAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8000/v1/chat/completions', timeoutMs = 600000 } = {}) {
    super()
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new TypeError('LoCoMo evaluation model URL must use loopback HTTP')
    }
    this.baseUrl = url.toString()
    this.timeoutMs = timeoutMs
    this.bySession = new Map()
  }

  providerInfo(provider) {
    if (provider !== PROVIDER) throw new Error('unexpected LoCoMo provider route')
    return { id: provider, name: 'Local Qwen for LoCoMo parity' }
  }

  async resolveModel(provider, model) {
    if (provider !== PROVIDER || model !== MODEL) throw new Error('unexpected LoCoMo model route')
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
    }
  }

  metrics(sessionId) {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  async *stream(options) {
    if (options.provider !== PROVIDER || options.model !== MODEL) throw new Error('unexpected LoCoMo model call')
    if (options.tools?.length) throw new Error('LoCoMo parity composition exposes no model tools')
    const sessionId = options.sessionId ?? 'unknown-session'
    const startedAt = Date.now()
    const startedClock = performance.now()
    let firstTokenAt
    let promptTokens
    let completionTokens
    let totalTokens
    let finishKind = 'stop'
    let text = ''
    let reasoning = ''
    let reasoningStarted = false
    const record = {
      sessionId,
      requestStartedAt: startedAt,
      firstTokenAt: undefined,
      finishedAt: undefined,
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: undefined,
    }
    const calls = this.bySession.get(sessionId) ?? []
    calls.push(record)
    this.bySession.set(sessionId, calls)

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const body = {
      model: MODEL,
      messages: options.messages.map(message => ({ role: message.role, content: textFromMessage(message) })),
      temperature: options.temperature ?? 0,
      seed: options.seed ?? 0,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { ...attributionHeaders(), authorization: 'Bearer local-only', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok || !response.body) {
      const status = response.status
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`local Qwen endpoint returned HTTP ${status}`)
    }

    let buffer = ''
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (true) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          const payload = parseData(line)
          if (payload === null) continue
          if (!payload) continue
          const usage = payload.usage
          if (usage) {
            promptTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : promptTokens
            completionTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : completionTokens
            totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : totalTokens
          }
          const choice = payload.choices?.[0]
          const delta = choice?.delta
          if (typeof delta?.content === 'string' && delta.content.length) {
            if (firstTokenAt === undefined) {
              firstTokenAt = Date.now()
              record.firstTokenAt = firstTokenAt
            }
            text += delta.content
            yield { type: 'text-delta', index: 0, text: delta.content }
          }
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length) {
            if (firstTokenAt === undefined) {
              firstTokenAt = Date.now()
              record.firstTokenAt = firstTokenAt
            }
            if (!reasoningStarted) {
              reasoningStarted = true
              yield { type: 'block-start', index: 1, blockType: 'reasoning' }
            }
            reasoning += delta.reasoning_content
            yield { type: 'reasoning-delta', index: 1, text: delta.reasoning_content }
          }
          if (choice?.finish_reason === 'length') finishKind = 'max-tokens'
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        const payload = parseData(buffer)
        if (payload && typeof payload === 'object') {
          const usage = payload.usage
          if (usage) {
            promptTokens = usage.prompt_tokens
            completionTokens = usage.completion_tokens
            totalTokens = usage.total_tokens
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (reasoningStarted) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
    if (promptTokens !== undefined || completionTokens !== undefined) {
      const inputTokens = promptTokens ?? 0
      const outputTokens = completionTokens ?? 0
      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          ...(totalTokens === undefined ? {} : { totalTokens }),
        },
      }
    }
    record.finishedAt = Date.now()
    record.promptTokens = promptTokens
    record.completionTokens = completionTokens
    record.totalTokens = totalTokens
    record.durationMs = Math.max(0, performance.now() - startedClock)
    record.responseSha256 = createHash('sha256').update(text).digest('hex')
    yield { type: 'finish', reason: { kind: finishKind } }
  }
}

export const LOCAL_QWEN_PROVIDER = PROVIDER
