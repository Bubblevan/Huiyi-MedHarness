import type { MemorySnapshot } from '../../../src/memory/contracts.js'

/** Evaluation-only QANemori semantics adapted from pinned AMA a770f9a. */
export const LOCOMO_QA_SYSTEM_PROMPT = [
  'You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.',
  '',
  '# CONTEXT',
  'You have access to memories from two speakers in a conversation. These memories contain timestamped information that may be relevant to answering the current question.',
  '',
  '# INSTRUCTIONS',
  '1. Carefully analyze all provided memories from both speakers.',
  '2. Pay special attention to timestamps to determine the correct answer.',
  '3. For a specific event or fact, look for direct evidence in the memories.',
  '4. If memories contain contradictory information, prioritize the most recent memory.',
  '5. A memory timestamp records when the memory was written, not necessarily when its described event happened.',
  '6. When content contains relative expressions such as yesterday, last week, or last Friday, use that memory timestamp as a reference and normalize the expression to an explicit date. Use the timestamp itself only when the content has no relative time expression.',
  '7. Focus only on the supplied conversation memories. Do not confuse character names mentioned in memories with the actual users who created them.',
  '8. Answer concisely, ideally in six words or fewer and at most ten words when a normalized time expression needs them.',
  '',
  '# APPROACH',
  'Review memories relevant to the current question, compare timestamps when resolving temporal order, compute dates for relative time expressions, and answer only what the memories support. Do not invent missing history or use external medical or world knowledge.',
  '',
  'Return only one valid JSON object with keys "question", "answer", and "evidence". Put the current user question in "question", a concise answer in "answer", and source references in "evidence" when present; otherwise use an empty array.',
].join('\n')

/**
 * Preserve AMA's three retrieval groups and timestamp-bearing content while
 * keeping internal IDs, ranks, and scores out of the DSH prompt.
 */
export function renderLocomoMemoryContext(snapshot: MemorySnapshot): string {
  const content = (item: MemorySnapshot['items'][number]) =>
    item.timestamp && !item.content.includes('\ntimestamp:')
      ? `${item.content}\ntimestamp:${item.timestamp}`
      : item.content
  const retrievals = {
    text_match_results: snapshot.items.filter(item => item.kind === 'raw').map(item => ({ content: content(item) })),
    fact_match_results: snapshot.items.filter(item => item.kind === 'fact').map(item => ({ content: content(item) })),
    episodes_results: snapshot.items.filter(item => item.kind === 'episode').map(item => ({ content: content(item) })),
  }
  return [
    'LoCoMo evaluation memories. Use them only as conversation history:',
    JSON.stringify({ retrievals, memoryWindow: [] }, null, 2),
  ].join('\n')
}
