import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../src/memory/contracts.js'
import { LOCOMO_QA_SYSTEM_PROMPT, renderLocomoMemoryContext } from '../eval/memory/locomo/prompt.js'

describe('LoCoMo parity prompt', () => {
  it('keeps AMA timestamp, conflict, memory-only, concise JSON answer semantics', () => {
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('timestamp records when the memory was written')
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('prioritize the most recent memory')
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('Do not invent missing history')
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('keys "question", "answer", and "evidence"')
  })

  it('preserves all three retrieval kinds and timestamps without backend metadata', () => {
    const snapshot: MemorySnapshot = {
      snapshotId: 'private-snapshot-id', userId: 'private-user-id', sessionId: 'private-session-id', turn: 1,
      items: [
        { kind: 'raw', content: 'raw memory', timestamp: '2023-05-08', source: 'private-source' },
        { kind: 'fact', content: 'fact memory\ntimestamp:2023-05-09' },
        { kind: 'episode', content: 'episode memory' },
      ],
    }

    const rendered = renderLocomoMemoryContext(snapshot)
    expect(rendered).toContain('"text_match_results"')
    expect(rendered).toContain('"fact_match_results"')
    expect(rendered).toContain('"episodes_results"')
    expect(rendered).toContain('raw memory\\ntimestamp:2023-05-08')
    expect(rendered).toContain('fact memory\\ntimestamp:2023-05-09')
    expect(rendered).toContain('episode memory')
    expect(rendered).not.toContain('private-snapshot-id')
    expect(rendered).not.toContain('private-user-id')
    expect(rendered).not.toContain('private-session-id')
    expect(rendered).not.toContain('private-source')
  })
})
