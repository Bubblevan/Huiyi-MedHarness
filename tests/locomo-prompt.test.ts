import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../src/memory/contracts.js'
import { LOCOMO_QA_SYSTEM_PROMPT, renderLocomoMemoryContext } from '../eval/memory/locomo/prompt.js'

describe('LoCoMo parity prompt', () => {
  it('keeps AMA timestamp, conflict, evidence-reference, concise JSON semantics', () => {
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('timestamp is NOT necessarily the time of the described event')
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('always prioritize the most recent memory')
    expect(LOCOMO_QA_SYSTEM_PROMPT).toContain('You must first adjust the date mathematically')
  })

  it('preserves all three retrieval kinds and timestamps without backend metadata', () => {
    const snapshot: MemorySnapshot = {
      snapshotId: 'private-snapshot-id', userId: 'private-user-id', sessionId: 'private-session-id', turn: 1,
      items: [
        { kind: 'raw', content: 'raw memory', timestamp: '2023-05-08', source: 'private-source', sourceId: 'D1:2' },
        { kind: 'fact', content: 'fact memory\ntimestamp:2023-05-09' },
        { kind: 'episode', content: 'episode memory' },
      ],
    }

    const rendered = renderLocomoMemoryContext(snapshot, 'What happened before?')
    expect(rendered).toMatch(/^Memories:/)
    expect(rendered).toContain('"text_match_results"')
    expect(rendered).toContain('"fact_match_results"')
    expect(rendered).toContain('"episodes_results"')
    expect(rendered).toContain('raw memory\\ntimestamp:2023-05-08')
    expect(rendered).toContain('"dia_id": "D1:2"')
    expect(rendered).toContain('fact memory\\ntimestamp:2023-05-09')
    expect(rendered).toContain('episode memory')
    expect(rendered).toContain('Question: What happened before?')
    expect(rendered).toContain('Return ONLY a JSON object in this exact format:')
    expect(rendered).toContain('"evidence": ["D2:6"]')
    expect(rendered).not.toContain('private-snapshot-id')
    expect(rendered).not.toContain('private-user-id')
    expect(rendered).not.toContain('private-session-id')
    expect(rendered).not.toContain('private-source')
    expect(rendered).not.toContain('"id"')
  })
})
