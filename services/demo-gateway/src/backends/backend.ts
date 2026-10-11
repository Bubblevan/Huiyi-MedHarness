import type { ChatInput, DemoEvent } from "../contracts.js";

export interface DemoBackend {
  run(input: ChatInput, context: { runId: string; signal: AbortSignal }): AsyncIterable<DemoEvent>;
  cancel(runId: string): void;
  closeSession?(sessionId: string, patientId: string, encounterId?: string): Promise<void>;
  dispose?(): Promise<void>;
}
