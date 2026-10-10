# Experimental vLLM Frontend Backend Validation

Date: 2026-10-10
Repository: `Bubblevan/Huiyi-MedHarness`
Backend: native DSH with local vLLM, Health Engine, and the prepared HC-RAG-002 corpus

## Result

The local experimental backend passed the exercised frontend-to-model flows and the malformed-request checks listed below. The production-shaped path ran in Chromium as:

```text
Demo Web → Demo Gateway → DSH root AgentLoop → local vLLM
                                  ├── local Health Engine / RAG
                                  └── DSH clinical collaboration children
                         → streamed result back to the same frontend session
```

The browser completed a normal synthetic turn, a turn that used both local medical retrieval and clinical collaboration, cancellation followed by recovery, and two independent sessions running concurrently. The evidence panel showed local retrieval results. No raw prompt, answer, patient data, or evidence passage was saved in this report.

## Validation results

| Area | Result |
|---|---:|
| Core unit tests | 72 passed / 9 files |
| Demo Gateway unit and HTTP tests | 19 passed / 3 files |
| Demo Web component tests | 5 passed / 1 file |
| Health Engine tests | 36 passed |
| Live DSH/vLLM browser tests | 6 passed, 2 fixture-only tests skipped (44.5 s) |
| TypeScript checks | Core, Gateway, and Web passed |
| Builds | Core, Gateway, and Web passed |
| Combined executed tests | 138 passed, 2 skipped |

The Web build emits the existing Vite chunk-size advisory for the 824.33 kB JavaScript bundle; the build succeeds.

## Request and lifecycle cases exercised

- `text/plain` chat body rejected with HTTP 415.
- Unexpected `systemPrompt` request field rejected with HTTP 400.
- Malformed JSON rejected with HTTP 400; 32 concurrent malformed requests all returned 400 and the health route remained available.
- JSON `null`, arrays, strings, numbers, missing fields, wrong field types, invalid session IDs, and unsupported scenario values returned HTTP 400.
- A 20,000-character request rejected with HTTP 413.
- The documented 4,000-character CJK message was accepted by the Gateway contract and HTTP boundary.
- Malformed percent escapes in patient and cancellation paths returned HTTP 400; the service remained available.
- Cross-origin JSON request from a different local port was blocked by the browser. Vite now disables permissive development CORS; its preflight returned 404 with no cross-origin allow header.
- An over-limit message submitted through the UI produced a visible safe error; a later valid turn completed.
- DSH cancellation stopped an in-flight collaboration turn, and a later session completed.
- Same-session overlap, session capacity, patient-context isolation, LRU disposal, and shutdown racing with session creation were covered by deterministic Gateway backend tests.
- Evidence HTML is rendered as text in the component test.

## Runtime evidence

- Model: local `Qwen/Qwen3-8B`, vLLM `0.30.1rc1.dev622+gf03026a54`, BF16, loopback-only on port 8000.
- Gateway health reported backend `dsh`; Gateway, vLLM, Health Engine, and RAG status endpoints all returned HTTP 200 after the browser run.
- HC-RAG-002 index verification passed before this run: corpus version `medtext-2026-10-07-c840ea8370341f41`, 2 sources, 509,897 chunks, MedCPT query encoder.
- vLLM cumulative service counters at the end of validation: 98,835 prompt tokens, 9,630 generated tokens, 79 requests finished with `stop`, and 0 finished with `length`, `abort`, or `error`. These counters cover the validation service lifetime, not only the final Playwright invocation.
- Post-run GPU snapshot: NVIDIA L40, 36,991 / 46,068 MiB allocated, 0% utilization, 46 °C, 86.67 W. During the live tool workflow the GPU was observed active at 100% utilization; the model remained loaded afterward.
- Gateway logs contain terminal metadata only. The validation summary records aggregate terminal status counts and durations, without request text.

## What this establishes

The local experimental path can answer the tested UI requests, invoke local RAG and the bounded clinical collaboration tool, stream a final response, handle cancellation, isolate concurrent synthetic sessions, and return controlled errors for the malformed and oversized requests tested here.

It is not a public deployment security audit, a sustained load/DoS test, or a medical accuracy evaluation. The services were bound to loopback, only 32 malformed requests were burst concurrently, and only two independent live browser sessions were exercised together. The UI patient and memory context were synthetic; no AMA write path was exercised. No MedQA set, reserved TEST labels, or model training was used.

## Commands and execution notes

Tests, TypeScript, and builds were run with Node `v22.23.3` and the repository's already-installed local binaries. The pinned `pnpm@11.7.0` commands could not access the package-manager SQLite store in this sandbox, so no `pnpm install` was attempted and the equivalent scripts were invoked directly. Gateway HTTP tests and Chromium live-browser tests ran with loopback access enabled.
