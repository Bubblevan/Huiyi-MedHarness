import { createHash } from 'node:crypto'
import type { CaseComplexity, CollaborationProfile } from './contracts.js'
import type { ClinicalChildKind, ClinicalStopReason } from './runner.js'

export interface CollaborationTraceRecord {
  readonly event: 'child' | 'policy'
  readonly caseHash: string
  readonly profile: CollaborationProfile
  readonly complexity: CaseComplexity
  readonly task: ClinicalChildKind
  readonly roleLabel: string
  readonly childRunId?: string
  readonly startedAt: number
  readonly endedAt: number
  readonly durationMs: number
  readonly stopReason?: ClinicalStopReason
  readonly status: 'completed' | 'failed' | 'skipped'
  readonly round?: number
  readonly childRunCount: number
  readonly degraded: boolean
  readonly failureClass?: string
}

export interface CollaborationTraceSink {
  record(record: CollaborationTraceRecord): void
}

/** Trace records contain hashes and lifecycle metadata only. */
export class MetadataCollaborationTrace implements CollaborationTraceSink {
  readonly records: CollaborationTraceRecord[] = []

  constructor(private readonly onRecord?: (record: CollaborationTraceRecord) => void) {}

  record(record: CollaborationTraceRecord): void {
    const safeRecord = Object.freeze({ ...record })
    this.records.push(safeRecord)
    this.onRecord?.(safeRecord)
  }
}

export function hashCaseQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex')
}

export function safeFailureClass(value: unknown): string {
  if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) return value
  if (value instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.name)) return value.name
  return 'UnknownError'
}
