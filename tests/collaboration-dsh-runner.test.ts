import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DshClinicalChildRunner } from '../src/collaboration/dsh-runner.js'
import type { DshCollaborationContext } from '../src/collaboration/dsh-runner.js'
import type { ClinicalChildRequest } from '../src/collaboration/runner.js'
import { complexityDecisionSchema } from '../src/collaboration/schemas.js'

const parent = { session: { id: 'root-session' } } as unknown as Agent
const identity = (value: unknown): unknown => value

function request(overrides: Partial<ClinicalChildRequest> = {}): ClinicalChildRequest {
  return {
    kind: 'complexity-classifier',
    label: 'test-classifier',
    roleLabel: 'classifier',
    prompt: 'synthetic prompt',
    persona: 'synthetic persona',
    outputSchema: complexityDecisionSchema,
    decode: value => value,
    ...overrides,
  }
}

function makeContext(
  result: Promise<{ stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'; structured?: unknown }>,
  options: { providers?: string[]; dispose?: () => Promise<void> } = {},
) {
  const handle = { id: 'child-session-1', result, dispose: vi.fn(options.dispose ?? (async () => undefined)) }
  const captured: { provider?: string; request?: Record<string, unknown> } = {}
  const start = vi.fn(async (provider: string, startRequest: Record<string, unknown>) => {
    captured.provider = provider
    captured.request = startRequest
    return handle
  })
  const ctx = {
    subagents: { list: () => options.providers ?? ['spawn'], start },
  } as unknown as DshCollaborationContext
  return { ctx, handle, captured, start }
}

describe('DSH clinical child runner', () => {
  it('uses spawn with the exact parent, caller signal, schema, persona, maxDepth 1, and no inherited tools', async () => {
    const { ctx, captured } = makeContext(Promise.resolve({
      stopReason: 'completed', structured: { complexity: 'basic', rationaleSummary: 'synthetic' },
    }))
    const runner = new DshClinicalChildRunner(ctx)
    const signal = new AbortController().signal
    const result = await runner.run(parent, request(), signal)
    expect(result.status).toBe('completed')
    expect(captured.provider).toBe('spawn')
    expect(captured.request).toMatchObject({ parent, signal, maxDepth: 1, toolFilter: { allow: [] }, persona: 'synthetic persona' })
    expect(captured.request?.outputSchema).toBe(complexityDecisionSchema)
    expect(captured.request?.prompt).toEqual([{ type: 'text', text: 'synthetic prompt' }])
  })

  it('does not start when the configured provider is absent', async () => {
    const { ctx, start } = makeContext(Promise.resolve({ stopReason: 'completed', structured: {} }), { providers: [] })
    const result = await new DshClinicalChildRunner(ctx).run(parent, request(), new AbortController().signal)
    expect(start).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'failed', failureClass: 'ProviderUnavailable' })
  })

  it.each([
    ['completed', { stopReason: 'completed', structured: { ok: true } }, identity, 'completed'],
    ['error', { stopReason: 'error', structured: { partial: 'must not parse' } }, identity, 'failed'],
    ['max tokens', { stopReason: 'max-tokens', structured: { partial: 'must not parse' } }, identity, 'failed'],
    ['missing structured value', { stopReason: 'completed' }, identity, 'failed'],
    ['domain validation throws', { stopReason: 'completed', structured: { malformed: true } }, () => { throw new TypeError('PRIVATE DETAIL') }, 'failed'],
  ] as const)('disposes the published handle after %s', async (_name, terminal, decode, expectedStatus) => {
    const { ctx, handle } = makeContext(Promise.resolve(terminal as { stopReason: 'completed' | 'error' | 'max-tokens'; structured?: unknown }))
    const result = await new DshClinicalChildRunner(ctx).run(parent, request({ decode }), new AbortController().signal)
    expect(result.status).toBe(expectedStatus)
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('PRIVATE DETAIL')
  })

  it('passes cancellation into the DSH run, settles it, and disposes the handle', async () => {
    let resolveResult: ((value: { stopReason: 'aborted' }) => void) | undefined
    let signalFromStart: AbortSignal | undefined
    let started: (() => void) | undefined
    const startSignal = new Promise<void>(resolve => { started = resolve })
    const childResult = new Promise<{ stopReason: 'aborted' }>(resolve => { resolveResult = resolve })
    const handle = { id: 'cancelled-child', result: childResult, dispose: vi.fn(async () => undefined) }
    const ctx = {
      subagents: {
        list: () => ['spawn'],
        start: async (_provider: string, startRequest: Record<string, unknown>) => {
          signalFromStart = startRequest.signal as AbortSignal
          signalFromStart.addEventListener('abort', () => resolveResult?.({ stopReason: 'aborted' }), { once: true })
          started?.()
          return handle
        },
      },
    } as unknown as DshCollaborationContext
    const controller = new AbortController()
    const pending = new DshClinicalChildRunner(ctx).run(parent, request(), controller.signal)
    await startSignal
    controller.abort()
    const result = await pending
    expect(signalFromStart).toBe(controller.signal)
    expect(result).toMatchObject({ status: 'failed', stopReason: 'aborted' })
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes if downstream structured decoding throws after completion', async () => {
    const { ctx, handle } = makeContext(Promise.resolve({ stopReason: 'completed', structured: { anything: true } }))
    const result = await new DshClinicalChildRunner(ctx).run(parent, request({ decode: () => { throw new Error('PRIVATE OUTPUT') } }), new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', failureClass: 'InvalidStructuredOutput' })
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('PRIVATE OUTPUT')
  })

  it('disposes and marks the child failed if disposal itself rejects', async () => {
    const { ctx, handle } = makeContext(
      Promise.resolve({ stopReason: 'completed', structured: { ok: true } }),
      { dispose: async () => { throw new Error('private cleanup detail') } },
    )
    const result = await new DshClinicalChildRunner(ctx).run(parent, request(), new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', failureClass: 'RunDisposalFailed' })
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('private cleanup detail')
  })

  it('records an allowlisted validation category without retaining rejected output or error text', async () => {
    const { ctx, handle } = makeContext(Promise.resolve({ stopReason: 'completed', structured: { complexity: 'BASIC' } }))
    const decode = () => { throw new TypeError('invalid case complexity') }
    const result = await new DshClinicalChildRunner(ctx).run(parent, request({ decode }), new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', failureClass: 'InvalidStructuredOutput', validationCode: 'invalid_case_complexity' })
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('invalid case complexity')
    expect(JSON.stringify(result)).not.toContain('BASIC')
  })

  it('does not expose an unknown validation error message as metadata', async () => {
    const { ctx } = makeContext(Promise.resolve({ stopReason: 'completed', structured: {} }))
    const decode = () => { throw new TypeError('private provider output') }
    const result = await new DshClinicalChildRunner(ctx).run(parent, request({ decode }), new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', failureClass: 'InvalidStructuredOutput' })
    expect(JSON.stringify(result)).not.toContain('private provider output')
    expect(JSON.stringify(result)).not.toContain('validationCode')
  })
})
