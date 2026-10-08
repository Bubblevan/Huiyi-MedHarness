import type { ChatInput, DemoEvent } from "../contracts.js";
import type { DemoBackend } from "./backend.js";

/** Integration seam only. A future host must pass an existing native DSH Session/AgentLoop. */
export class DshDemoBackend implements DemoBackend {
  async *run(_input: ChatInput, _context: { runId: string; signal: AbortSignal }): AsyncIterable<DemoEvent> {
    throw new Error("BACKEND_UNAVAILABLE: DSH Web adapter is not enabled in this task");
  }

  cancel(_runId: string): void {
    // TODO(next phase): map the transport run to DSH's native cooperative cancellation seam.
  }
}
