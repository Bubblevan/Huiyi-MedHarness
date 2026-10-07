import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MemoryTraceRecord } from './contracts.js'

export interface MemoryTraceSink {
  record(record: MemoryTraceRecord): void
}

export class MetadataMemoryTrace implements MemoryTraceSink {
  constructor(private readonly filePath = process.env.HUIYI_MEMORY_TRACE_FILE) {}

  record(record: MemoryTraceRecord): void {
    const line = JSON.stringify(record)
    if (!this.filePath) {
      console.info(`[huiyi-memory] ${line}`)
      return
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error: unknown) {
      const errorClass = error instanceof Error ? error.name : 'UnknownError'
      console.error(`[huiyi-memory] metadata trace write failed (${errorClass})`)
    }
  }
}
