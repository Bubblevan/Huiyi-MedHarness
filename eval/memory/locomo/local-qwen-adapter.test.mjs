import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalQwenAdapter, LOCAL_QWEN_PROVIDER } from './local-qwen-adapter.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('LoCoMo local Qwen adapter', () => {
  it('sends the shared 256-token cap and reports a max-token finish', async () => {
    const events = [
      { choices: [{ delta: { content: '{"answer":' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      { choices: [], usage: { prompt_tokens: 40, completion_tokens: 256, total_tokens: 296 } },
    ]
    const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).max_tokens).toBe(256)
      expect(JSON.parse(init.body).seed).toBe(0)
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))

    const adapter = new LocalQwenAdapter({ baseUrl: 'http://127.0.0.1:8000/v1/chat/completions' })
    const frames = []
    for await (const frame of adapter.stream({
      provider: LOCAL_QWEN_PROVIDER,
      model: 'Qwen3-8B',
      sessionId: 'locomo-test',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'fixed test' }] }],
      temperature: 0,
      maxTokens: 256,
      tools: [],
    })) frames.push(frame)

    expect(frames.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(adapter.metrics('locomo-test')[0].completionTokens).toBe(256)
  })
})
