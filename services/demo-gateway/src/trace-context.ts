import { AsyncLocalStorage } from "node:async_hooks";

export interface GatewayTraceContext {
  readonly requestId: string;
  readonly runId: string;
  readonly edgeTraceId?: string;
}

const traceContext = new AsyncLocalStorage<GatewayTraceContext>();
const installedFetch = Symbol.for("huiyi.gateway.trace-fetch-installed");

export function runWithGatewayTraceContext<T>(context: GatewayTraceContext, operation: () => T): T {
  return traceContext.run(context, operation);
}

/**
 * Carries opaque correlation IDs only from a local DSH run to the loopback
 * Codex bridge. It is deliberately scoped to that endpoint; no model payload
 * or credential is inspected or logged.
 */
export function installGatewayTraceFetchAdapter(): void {
  const fetchTarget = globalThis as typeof globalThis & { [key: symbol]: unknown };
  if (fetchTarget[installedFetch]) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const context = traceContext.getStore();
    if (!context || process.env.HUIYI_DEMO_MODEL_BACKEND?.trim() !== "codex-app-server" || !isLocalCodexCompletion(input)) {
      return originalFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("x-huiyi-request-id", context.requestId);
    headers.set("x-huiyi-run-id", context.runId);
    if (context.edgeTraceId) headers.set("x-huiyi-trace-id", context.edgeTraceId);
    return originalFetch(input, { ...init, headers });
  }) as typeof globalThis.fetch;
  Object.defineProperty(fetchTarget, installedFetch, { value: true, configurable: false });
}

function isLocalCodexCompletion(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(raw);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && url.pathname.replace(/\/$/, "").endsWith("/v1/chat/completions");
  } catch {
    return false;
  }
}
