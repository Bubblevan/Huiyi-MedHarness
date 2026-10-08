import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FixtureDemoBackend } from "../../services/demo-gateway/dist/backends/fixture.js";

const backend = new FixtureDemoBackend({ delayMs: 0 });
const events = [];
for await (const event of backend.run({
  sessionId: "session_synthetic_artifact",
  patientId: "patient-complex",
  message: "synthetic fixture artifact query",
  scenario: "complex",
}, { runId: "run_synthetic_artifact", signal: new AbortController().signal })) {
  events.push(JSON.stringify(event));
}

const target = resolve("artifacts/demo-edge-local/fixture-event-trace.jsonl");
await mkdir(resolve(target, ".."), { recursive: true });
await writeFile(target, `${events.join("\n")}\n`, "utf8");
process.stdout.write(`Wrote ${events.length} synthetic events to ${target}\n`);
