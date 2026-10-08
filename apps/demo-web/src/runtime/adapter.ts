import type { ChatModelAdapter, ChatModelRunOptions } from "@assistant-ui/react";

export type Scenario = "simple" | "complex" | "failure";

export interface WireDemoEvent {
  version: 1;
  event: string;
  runId: string;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface AdapterOptions {
  patientId: string;
  sessionId: string;
  scenario: Scenario;
  onEvent: (event: WireDemoEvent) => void;
  onError: (message: string) => void;
  apiBase?: string;
}

function parseBlock(block: string): WireDemoEvent | undefined {
  const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) return undefined;
  const parsed: unknown = JSON.parse(data);
  return parseEnvelope(parsed);
}

function parseEnvelope(parsed: unknown): WireDemoEvent {
  if (typeof parsed !== "object" || parsed === null) throw new Error("INVALID_EVENT");
  const event = parsed as Partial<WireDemoEvent>;
  if (event.version !== 1 || typeof event.event !== "string" || typeof event.runId !== "string" ||
      typeof event.sessionId !== "string" || typeof event.timestamp !== "string" ||
      typeof event.data !== "object" || event.data === null) throw new Error("INVALID_EVENT");
  return event as WireDemoEvent;
}

export function createDemoAdapter(options: AdapterOptions): ChatModelAdapter {
  const apiBase = options.apiBase ?? import.meta.env.HUIYI_DEMO_API_BASE ?? "/api";
  return {
    async *run({ messages, abortSignal }: ChatModelRunOptions) {
      const latest = [...messages].reverse().find((message) => message.role === "user");
      const message = (latest?.content as readonly { type: string; text?: string }[] | undefined)
        ?.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
      if (!message) throw new Error("INVALID_REQUEST");

      let runId: string | null = null;
      const cancel = () => {
        if (!runId) return;
        void fetch(`${apiBase}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })
          .then(async (response) => {
            if (!response.ok) return;
            const payload = await response.json() as { event?: unknown };
            if (payload.event) options.onEvent(parseEnvelope(payload.event));
          })
          .catch(() => undefined);
      };
      abortSignal.addEventListener("abort", cancel, { once: true });
      try {
        const response = await fetch(`${apiBase}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: options.sessionId, patientId: options.patientId, message, scenario: options.scenario }),
          signal: abortSignal,
        });
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => ({})) as { error?: string };
          const code = payload.error ?? (response.status === 503 ? "GATEWAY_UNAVAILABLE" : "BACKEND_UNAVAILABLE");
          options.onError(code);
          throw new Error(code);
        }
        runId = response.headers.get("x-run-id");
        if (abortSignal.aborted) cancel();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let answer = "";
        while (!abortSignal.aborted) {
          const { value, done } = await reader.read();
          pending = (pending + decoder.decode(value, { stream: !done })).replaceAll("\r\n", "\n");
          let boundary = pending.indexOf("\n\n");
          while (boundary >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const event = parseBlock(block);
            if (event) {
              options.onEvent(event);
              if (event.event === "assistant.delta") {
                const delta = event.data.text;
                if (typeof delta === "string") {
                  answer += delta;
                  yield { content: [{ type: "text", text: answer }] };
                }
              } else if (event.event === "run.failed") {
                const code = typeof event.data.code === "string" ? event.data.code : "BACKEND_UNAVAILABLE";
                options.onError(code);
                throw new Error(code);
              } else if (event.event === "run.completed" || event.event === "run.cancelled") {
                return;
              }
            }
            boundary = pending.indexOf("\n\n");
          }
          if (done) break;
        }
        if (!abortSignal.aborted) throw new Error("STREAM_INTERRUPTED");
      } catch (error) {
        if (abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) return;
        const code = error instanceof Error ? error.message : "GATEWAY_UNAVAILABLE";
        options.onError(code);
        throw new Error("服务暂时不可用，请稍后重试。");
      } finally {
        abortSignal.removeEventListener("abort", cancel);
      }
    },
  };
}
