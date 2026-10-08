import type { MemorySnapshot } from '../memory/contracts.js'
import type { EvidenceSet } from '../rag/contracts.js'
import type { CollaborationSnapshot } from '../collaboration/contracts.js'

/** Shared, immutable input for one root DSH turn's clinical capabilities. */
export interface HealthCaseState {
  readonly query: string
  /** Patient history kept separate from external medical evidence. */
  readonly patientMemory?: MemorySnapshot
  /** Provenance-bearing external literature kept separate from patient history. */
  readonly externalEvidence?: EvidenceSet
  readonly collaboration?: CollaborationSnapshot
}
