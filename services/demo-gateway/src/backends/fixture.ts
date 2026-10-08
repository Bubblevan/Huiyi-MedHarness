import { createEvent, type ChatInput, type DemoEvent, type DemoScenario } from "../contracts.js";
import { getPatient } from "../fixtures.js";
import type { DemoBackend } from "./backend.js";

export interface FixtureBackendOptions { delayMs?: number }

const simpleAnswer = "先把早晚测量时间、读数和当时状态记录下来，复诊时带给医生一起评估。若出现明显不适，请及时联系医疗专业人员。该内容为合成演示。 [1](#evidence:ev-001)";
const complexAnswer = "这份合成病例适合先核对近期血压、血糖记录及正在使用的药物，再由相关专科结合完整病史评估。演示中的专家步骤仅模拟界面流程，不构成真实会诊或诊疗建议。 [1](#evidence:ev-001) [2](#evidence:ev-002)";

export class FixtureDemoBackend implements DemoBackend {
  private readonly active = new Map<string, AbortController>();
  private readonly delayMs: number;

  constructor(options: FixtureBackendOptions = {}) { this.delayMs = options.delayMs ?? 90; }

  cancel(runId: string): void { this.active.get(runId)?.abort(); }

  async *run(input: ChatInput, context: { runId: string; signal: AbortSignal }): AsyncIterable<DemoEvent> {
    const { runId, signal } = context;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
    this.active.set(runId, controller);
    const combinedSignal = controller.signal;
    const scenario: DemoScenario = input.scenario ?? (input.patientId === "patient-complex" ? "complex" : "simple");
    const startedAt = Date.now();
    const emit = <K extends Parameters<typeof createEvent>[0]>(
      event: K,
      data: Parameters<typeof createEvent<K>>[3],
    ) => createEvent(event, runId, input.sessionId, data);

    try {
      yield emit("run.started", { backend: "fixture", scenario });
      yield emit("context.patient", { patientId: input.patientId });
      const patient = getPatient(input.patientId);
      yield emit("context.memory", { itemCount: patient?.memory.items ?? 0 });
      await this.pause(combinedSignal);
      if (scenario === "failure") {
        yield emit("assistant.delta", { text: "已载入合成上下文，正在准备证据检索……" });
        await this.pause(combinedSignal);
        yield emit("run.failed", { code: "FIXTURE_FAILURE" });
        return;
      }

      yield emit("evidence.started", { queryLabel: "合成证据检索" });
      yield emit("tool.started", { tool: "search_demo_evidence" });
      await this.pause(combinedSignal);
      const evidence = scenario === "complex"
        ? [
            { evidenceId: "ev-001", rank: 1, source: "Demo evidence fixture", title: "居家血压记录（合成资料）", snippet: "记录测量时间、读数和相关情况，供复诊讨论。" },
            { evidenceId: "ev-002", rank: 2, source: "Demo evidence fixture", title: "随访信息核对（合成资料）", snippet: "整理当前用药与随访问题，交由医疗专业人员结合完整病史核对。" },
          ]
        : [{ evidenceId: "ev-001", rank: 1, source: "Demo evidence fixture", title: "居家血压记录（合成资料）", snippet: "记录测量时间、读数和相关情况，供复诊讨论。" }];
      for (const item of evidence) yield emit("evidence.item", item);
      yield emit("evidence.completed", { count: evidence.length });
      yield emit("tool.completed", { tool: "search_demo_evidence", durationMs: 18, status: "completed" });
      const isComplex = scenario === "complex";
      yield emit("agent.classified", { complexity: isComplex ? "intermediate" : "simple", simulated: isComplex });
      if (isComplex) {
        for (const specialist of ["心内科", "内分泌科"]) {
          yield emit("specialist.started", { specialist, simulated: true });
          await this.pause(combinedSignal);
          yield emit("specialist.completed", { specialist, durationMs: 42, simulated: true });
        }
      }
      const answer = isComplex ? complexAnswer : simpleAnswer;
      for (const chunk of this.chunks(answer, 13)) {
        await this.pause(combinedSignal);
        if (combinedSignal.aborted) break;
        yield emit("assistant.delta", { text: chunk });
      }
      if (combinedSignal.aborted) {
        yield emit("run.cancelled", { reason: "client_cancelled" });
        return;
      }
      yield emit("run.completed", { durationMs: Date.now() - startedAt });
    } catch (error) {
      if (combinedSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
        yield emit("run.cancelled", { reason: "client_cancelled" });
      } else {
        yield emit("run.failed", { code: "FIXTURE_FAILURE" });
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(runId);
    }
  }

  private chunks(value: string, size: number): string[] {
    const result: string[] = [];
    for (let index = 0; index < value.length; index += size) result.push(value.slice(index, index + size));
    return result;
  }

  private async pause(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("Run cancelled", "AbortError");
    if (this.delayMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Run cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
