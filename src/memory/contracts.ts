export type MemoryKind = 'raw' | 'fact' | 'episode'

export interface MemoryRecallRequest {
  userId: string
  sessionId: string
  turn: number
  query: string
  strong?: boolean
}

export interface MemoryItem {
  readonly kind: MemoryKind
  readonly content: string
  readonly timestamp?: string
  readonly source?: string
}

export interface MemorySnapshot {
  readonly snapshotId: string
  readonly userId: string
  readonly sessionId: string
  readonly turn: number
  readonly items: readonly MemoryItem[]
  readonly tokenEstimate?: number
  readonly retrievalRounds?: number
  readonly refreshTriggered?: boolean
  readonly amaLlmCallCount?: number
  readonly amaPromptTokens?: number
  readonly amaCompletionTokens?: number
  readonly amaUsageReportCount?: number
}

export interface MemoryCommitRequest {
  idempotencyKey: string
  userId: string
  sessionId: string
  turn: number
  userText: string
  assistantText: string
}

export interface MemoryCommitResult {
  status: 'committed' | 'duplicate' | 'in_progress' | 'failed'
  duplicate: boolean
  rawCount?: number
  factCount?: number
  episodeCount?: number
  amaLlmCallCount?: number
  refreshTriggered?: boolean
  episodeGenerated?: boolean
}

export interface MemorySessionEndRequest {
  userId: string
  sessionId: string
}

export interface MemorySessionEndResult {
  status: 'completed' | 'duplicate' | 'in_progress' | 'skipped' | 'failed'
  duplicate: boolean
  episodeGenerated?: boolean
  amaLlmCallCount?: number
}

export interface MemoryStats {
  userId: string
  memoryWindowItems: number
  records: {
    raw: number
    facts: number
    episodes: number
  }
}

export interface MemoryForgetRequest {
  userId: string
  confirmation: 'forget all patient memory'
}

export interface MemoryForgetResult {
  status: 'forgotten'
  recordsRemoved: number
}

export type MemoryOperation =
  | 'automatic_recall'
  | 'manual_recall'
  | 'commit'
  | 'session_end'
  | 'stats'
  | 'forget'

export interface MemoryTraceRecord {
  sessionId: string
  turn?: number
  operation: MemoryOperation
  status: 'completed' | 'failed' | 'skipped' | 'in_progress' | 'duplicate'
  itemCount?: number
  tokenEstimate?: number
  latencyMs?: number
  strongRetrieve?: boolean
  retrievalRounds?: number
  refreshTriggered?: boolean
  commitStatus?: MemoryCommitResult['status']
  errorClass?: string
  amaLlmCallCount?: number
  amaPromptTokens?: number
  amaCompletionTokens?: number
  amaUsageReportCount?: number
  episodeGenerated?: boolean
  totalDshTurnLatencyMs?: number
  time: number
}

export function emptyMemorySnapshot(
  userId: string,
  sessionId: string,
  turn: number,
  snapshotId = `empty:${sessionId}:${turn}`,
): MemorySnapshot {
  return { snapshotId, userId, sessionId, turn, items: [], tokenEstimate: 0 }
}
