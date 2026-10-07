import type { MemorySnapshot } from '../../../src/memory/contracts.js'

/**
 * The pinned AMA QANemoriPrompt split at its memory placeholder. In the DSH
 * profile the stable instructions stay in the system prompt while the
 * turn-specific memory, question and output contract are supplied together
 * as the memory context snapshot.
 */
export const LOCOMO_QA_SYSTEM_PROMPT = [
  'You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.',
  '',
  '# CONTEXT:',
  'You have access to memories from two speakers in a conversation. These memories contain',
  'timestamped information that may be relevant to answering the question.',
  '',
  '# INSTRUCTIONS:',
  '1. Carefully analyze all provided memories from both speakers.',
  '2. Pay special attention to the timestamps to determine the correct answer.',
  '3. If the question asks about a specific event or fact, look for direct evidence in the memories.',
  '4. If the memories contain contradictory information, always prioritize the most recent memory.',
  '',
  '[Temporal Reasoning Rule]',
  '- Every memory record includes a timestamp (the time the memory was written).',
  '- This timestamp is NOT necessarily the time of the described event.',
  '- When the content contains relative expressions (e.g., "yesterday", "last week", "last Friday"):',
  '    Step 1: Use the timestamp as a reference point.',
  '    Step 2: Compute the actual date of the event based on that relative phrase.',
  '    Step 3: Replace the relative expression with the calculated explicit date.',
  '    Step 4: Use the calculated date as the final answer.',
  '- Only when no relative time expression exists may you use the timestamp directly.',
  '',
  '5. When you see a timestamp like "timestamp: 2023-06-27" inside a memory:',
  '   - This timestamp indicates when that memory was recorded not when the event described in the content actually occurred.',
  '   - DO NOT use it as the final answer directly.',
  '   - Instead, use it as a REFERENCE to interpret relative time expressions inside that memory.',
  '',
  '6. If the content contains relative time expressions (e.g., "yesterday", "last week", "two days ago", "the week before"):',
  '   - You MUST calculate the corresponding absolute time relative to the reference timestamp.',
  '   - Example:',
  '       -  "...yesterday" + "timestamp: 2023-06-27" → "26 June 2023"',
  '       -  "...the week before" + "timestamp: 2023-06-27" → "the week before 27 June 2023"',
  '       -  "...last friday " + "timestamp: 2023-06-27" → "the friday before 27 June 2023"',
  '   - Replace relative expressions with the calculated explicit time.',
  '',
  '7. Only when the memory has no relative expression at all may you use the timestamp itself as the answer.',
  '',
  '8. Focus only on the content of the memories from both speakers. Do not confuse character names mentioned in memories with the actual users who created them.',
  '',
  '9. The final answer must be concise (ideally ≤ 6 words) but can go up to 10 words if needed to include a normalized time expression.',
  '',
  '# APPROACH (Think step by step):',
  '1. Examine all memories that relate to the question.',
  '2. Compare timestamps to resolve temporal order.',
  '3. Identify explicit dates, times, or events that answer the question.',
  '4. Perform necessary time conversions.',
  '5. Formulate a precise, concise answer based solely on evidence.',
  '6. Double-check that your answer directly and specifically addresses the question.',
  '7. Ensure no relative time expressions remain in the final answer.',
  '',
  '[Important Reminder]',
  'Never output the timestamp itself if a relative time phrase exists in the content.',
  'You must first adjust the date mathematically.',
].join('\n')

const QANEMORI_OUTPUT_SUFFIX = [
  'Return ONLY a JSON object in this exact format:',
  '{',
  '  "question": "What is Caroline\'s identity?",',
  '  "answer": "a transgender woman",',
  '  "evidence": ["D2:6"]',
  '}',
].join('\n')

/**
 * Preserve AMA's three retrieval groups, timestamps, source references, and
 * question/output template while keeping database IDs, ranks, and scores out.
 */
export function renderLocomoMemoryContext(snapshot: MemorySnapshot, query: string): string {
  const content = (item: MemorySnapshot['items'][number]) =>
    item.timestamp && !item.content.includes('\ntimestamp:')
      ? `${item.content}\ntimestamp:${item.timestamp}`
      : item.content
  const retrievals = {
    text_match_results: snapshot.items.filter(item => item.kind === 'raw').map(item => ({
      content: content(item),
      ...(item.sourceId ? { dia_id: item.sourceId } : {}),
    })),
    fact_match_results: snapshot.items.filter(item => item.kind === 'fact').map(item => ({
      content: content(item),
      ...(item.sourceId ? { dia_id: item.sourceId } : {}),
    })),
    episodes_results: snapshot.items.filter(item => item.kind === 'episode').map(item => ({
      content: content(item),
      ...(item.sourceId ? { dia_id: item.sourceId } : {}),
    })),
  }
  return [
    'Memories:',
    JSON.stringify({ retrievals, memoryWindow: [] }, null, 2),
    '',
    `Question: ${query}`,
    '',
    QANEMORI_OUTPUT_SUFFIX,
  ].join('\n')
}
