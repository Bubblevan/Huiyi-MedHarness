export const DEMO_EVENTS = [
  "run.started",
  "context.patient",
  "context.memory",
  "evidence.started",
  "evidence.item",
  "evidence.completed",
  "agent.classified",
  "specialist.started",
  "specialist.completed",
  "tool.started",
  "tool.completed",
  "collaboration.completed",
  "assistant.delta",
  "run.completed",
  "run.cancelled",
  "run.failed",
] as const;

export type DemoEventName = (typeof DEMO_EVENTS)[number];
export type DemoScenario = "simple" | "complex" | "failure";

export interface PatientContext {
  patientId: string;
  displayName: string;
  age: number;
  sex: string;
  encounter: string;
  conditions: string[];
  medications: string[];
  allergies: string[];
  memory: { summary: string; items: number; updatedLabel: string };
  suggestedQuestion: string;
}

export interface ChatInput {
  sessionId: string;
  patientId: string;
  message: string;
  scenario?: DemoScenario;
}

export interface EventDataMap {
  "run.started": { backend: "fixture" | "dsh"; scenario: DemoScenario };
  "context.patient": { patientId: string };
  "context.memory": { itemCount: number };
  "evidence.started": { queryLabel: string };
  "evidence.item": {
    evidenceId: string;
    rank: number;
    source: string;
    title: string;
    snippet: string;
  };
  "evidence.completed": { count: number };
  "agent.classified": { complexity: "simple" | "basic" | "intermediate" | "advanced"; simulated: boolean };
  "specialist.started": { specialist: string; simulated: boolean };
  "specialist.completed": { specialist: string; durationMs: number; simulated: boolean };
  "tool.started": { tool: string };
  "tool.completed": { tool: string; durationMs: number; status: "completed" | "failed" };
  "collaboration.completed": {
    complexity: "basic" | "intermediate" | "advanced";
    specialistRoles: string[];
    teamCount: number;
    completedChildRuns: number;
    failedChildRuns: number;
    degraded: boolean;
  };
  "assistant.delta": { text: string };
  "run.completed": { durationMs: number };
  "run.cancelled": { reason: "client_cancelled" };
  "run.failed": { code: "FIXTURE_FAILURE" | "BACKEND_UNAVAILABLE" | "BACKEND_FAILURE" | "MODEL_UNAVAILABLE" | "MODEL_FAILURE" | "MODEL_ROUTE_UNAVAILABLE" | "MODEL_UNKNOWN" | "MODEL_CREDENTIAL_MISSING" | "MODEL_CREDENTIAL_INVALID" | "MODEL_CONFIG_INVALID" | "MODEL_AUTH_FAILED" | "MODEL_TIMEOUT" | "MODEL_RATE_LIMIT" | "TURN_INCOMPLETE" | "SESSION_BUSY" | "SESSION_CAPACITY" | "RUN_TIMEOUT" };
}

export type DemoEvent = {
  [K in DemoEventName]: {
    version: 1;
    event: K;
    runId: string;
    sessionId: string;
    timestamp: string;
    data: EventDataMap[K];
  };
}[DemoEventName];

export function createEvent<K extends DemoEventName>(
  event: K,
  runId: string,
  sessionId: string,
  data: EventDataMap[K],
  timestamp = new Date().toISOString(),
): Extract<DemoEvent, { event: K }> {
  return { version: 1, event, runId, sessionId, timestamp, data } as Extract<DemoEvent, { event: K }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function isEventData(event: DemoEventName, data: unknown): boolean {
  if (!isRecord(data)) return false;
  switch (event) {
    case "run.started": return (data.backend === "fixture" || data.backend === "dsh") && ["simple", "complex", "failure"].includes(String(data.scenario));
    case "context.patient": return isText(data.patientId);
    case "context.memory": return isNumber(data.itemCount);
    case "evidence.started": return isText(data.queryLabel);
    case "evidence.item": return isText(data.evidenceId) && isNumber(data.rank) && isText(data.source) && isText(data.title) && isText(data.snippet);
    case "evidence.completed": return isNumber(data.count);
    case "agent.classified": return (["basic", "simple", "intermediate", "advanced"].includes(String(data.complexity))) && isBoolean(data.simulated);
    case "specialist.started": return isText(data.specialist) && isBoolean(data.simulated);
    case "specialist.completed": return isText(data.specialist) && isNumber(data.durationMs) && isBoolean(data.simulated);
    case "tool.started": return isText(data.tool);
    case "tool.completed": return isText(data.tool) && isNumber(data.durationMs) && (data.status === "completed" || data.status === "failed");
    case "collaboration.completed": return ["basic", "intermediate", "advanced"].includes(String(data.complexity))
      && Array.isArray(data.specialistRoles) && data.specialistRoles.every(isText)
      && isNumber(data.teamCount) && isNumber(data.completedChildRuns) && isNumber(data.failedChildRuns) && isBoolean(data.degraded);
    case "assistant.delta": return isText(data.text);
    case "run.completed": return isNumber(data.durationMs);
    case "run.cancelled": return data.reason === "client_cancelled";
    case "run.failed": return ["FIXTURE_FAILURE", "BACKEND_UNAVAILABLE", "BACKEND_FAILURE", "MODEL_UNAVAILABLE", "MODEL_FAILURE", "MODEL_ROUTE_UNAVAILABLE", "MODEL_UNKNOWN", "MODEL_CREDENTIAL_MISSING", "MODEL_CREDENTIAL_INVALID", "MODEL_CONFIG_INVALID", "MODEL_AUTH_FAILED", "MODEL_TIMEOUT", "MODEL_RATE_LIMIT", "TURN_INCOMPLETE", "SESSION_BUSY", "SESSION_CAPACITY", "RUN_TIMEOUT"].includes(String(data.code));
    default: return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled event: ${String(value)}`);
}

export function parseDemoEvent(value: unknown): DemoEvent {
  if (!isRecord(value) || value.version !== 1 || !isText(value.event) ||
      !DEMO_EVENTS.includes(value.event as DemoEventName) || !isText(value.runId) ||
      !isText(value.sessionId) || !isText(value.timestamp)) {
    throw new TypeError("Invalid Huiyi demo event envelope");
  }
  const event = value.event as DemoEventName;
  if (!isEventData(event, value.data)) throw new TypeError(`Invalid data for ${event}`);
  return value as unknown as DemoEvent;
}

export function validateChatInput(value: unknown): ChatInput {
  if (!isRecord(value) || Object.keys(value).some((key) =>
      key !== "sessionId" && key !== "patientId" && key !== "message" && key !== "scenario") ||
      !isText(value.sessionId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value.sessionId) ||
      !isText(value.patientId) || value.patientId.length > 80 ||
      !isText(value.message) || !value.message.trim() || value.message.length > 4000 ||
      (value.scenario !== undefined && !["simple", "complex", "failure"].includes(String(value.scenario)))) {
    throw new TypeError("Invalid chat request");
  }
  return {
    sessionId: value.sessionId,
    patientId: value.patientId,
    message: value.message.trim(),
    ...(value.scenario ? { scenario: value.scenario as DemoScenario } : {}),
  };
}
