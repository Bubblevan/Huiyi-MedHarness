# Synthetic follow-up draft and review workflow

## Runtime boundary

The draft is a product projection of the existing DSH turn. It does not add an Agent, Session, AgentLoop, or second model orchestrator.

The pinned DSH contract was checked before implementing the Gateway seam:

- `@deepseek-ai/dsh-agent@0.2.1-alpha.1` [`README.md`, §identified messages and inbox controls](../../node_modules/@deepseek-ai/dsh-agent/README.md#L47) documents `followup()` as queued next-turn input, `cancel()` as turn cancellation, and `whenIdle()` as the quiescence boundary.
- `@deepseek-ai/dsh-agent-loop@0.2.1-alpha.1` [`README.md`, §driver and stream settlement](../../node_modules/@deepseek-ai/dsh-agent-loop/README.md#L118) records assistant stream chunks only after the matching durable assistant frame settles. The [cancellation note](../../node_modules/@deepseek-ai/dsh-agent-loop/README.md#L75) says cancellation finalizes the text already delivered.
- Huiyi’s adapter [observes root-session events and root-only text stream](../../services/demo-gateway/src/backends/dsh-runtime.ts#L158); its `DshDemoBackend` [calls `followup()`, awaits `whenIdle()`, flushes memory, then emits `run.completed`](../../services/demo-gateway/src/backends/dsh.ts#L352).
- The Gateway [captures the delivered root `assistant.delta` and persists only when it receives `run.completed`](../../services/demo-gateway/src/server.ts#L470). Cancelled or failed runs do not take this branch. A draft persistence error is returned as metadata-only `draft.save_failed`; it does not replace the completed clinical response.

Thus the result admission point is the existing root `run.completed` event after DSH turn settlement and AMA flush. Evidence is captured only from the existing `evidence.item` events. Child-agent prose, private DSH events, complete Memory snapshots, or the browser’s own rendered text are never used to create a draft.

## Draft contents and sources

`ClinicalDraftRegistry` builds one synthetic preliminary draft per authorized patient/Encounter assignment. It uses:

- Server-resolved synthetic PatientContext for known conditions, medication, allergy, and the separately labelled synthetic longitudinal context.
- The user message already received by the Gateway and root answer emitted by the DSH backend.
- Evidence items returned through the existing DSH evidence events, retained in their own section with evidence ID, source, title, and excerpt.
- A generic checklist for medication and original test-report verification. These checklist prompts are workflow tasks, not claims about the patient.

Risk signals remain empty unless a source explicitly provides them. The draft labels an empty risk section as “not assessed”; it does not imply “no risk.” Missing or unstructured data is not inferred. Each item has source metadata and a demo-only disposition (`unreviewed`, `confirmed-in-demo`, or `rejected-in-demo`).

The evaluation runner’s [`fhir-draft.ts`](../../eval/clinical/fhir-draft.ts) now produces a `Composition.status=preliminary` with explicit sections for chief concern/change, prior history, medication, allergy, symptoms/tests, verification tasks, risk-related source facts, external evidence, model response, and uncertainty. Source facts carry fact/Encounter references and a synthetic tag. Risk-related facts are labelled as source material, not as findings detected by the Agent.

## Review actions and privacy boundary

The clinical-evaluation Gateway exposes:

- `GET /api/patients/:patientId/encounters/:encounterId/draft`: requires an authenticated principal and rechecks tenant, access group, patient, and Encounter authorization.
- `PATCH /api/clinical-drafts/:draftId`: requires the same-site origin, authenticated clinician role, an expected version, and a bounded field-level change list. Stale versions return `409 DRAFT_VERSION_CONFLICT`.

Every edit, field disposition, follow-up request, rejection, and demo approval records an actor, timestamp, action, and before/after snapshot. `approved-in-demo` is a separate workflow state; `clinicalApprovalStatus` remains `not-performed`. No action creates a licensed clinician sign-off, unlocks clinical scores, or writes to a real EMR.

The default local store is ignored at `services/demo-gateway/data/clinical-evaluation/review-drafts.json`. Set `HUIYI_CLINICAL_DRAFT_STORE_PATH` to move it. The store is local synthetic working data; keep it outside source control and do not use this store for real patient data. Writes are atomic and serialized within one Gateway process; deploy only one writer for a given file.

## Verification

The offline acceptance path is the Gateway draft-registry and clinical-evaluation API test suite, the `eval/clinical/fhir-draft.ts` unit assertion, Gateway TypeScript build, and demo-web tests/build. These verify source separation, authorization, version conflicts, before/after history, cancellation non-admission, synthetic-only status, safe activity metadata, and the demo-only approval state. A live model call is not necessary to verify persistence and authorization; full DSH/AMA/RAG clinical quality still requires the separate paired evaluation and human-review gates in HY-CLINICAL-001.
