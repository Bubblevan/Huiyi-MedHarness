# Demo reference study

Research completed 2026-10-09 against the upstream default branches. The SHAs below pin the exact source snapshots inspected for this task. Huiyi reimplements the information hierarchy and interaction patterns; no upstream UI source was copied or vendored.

## `assistant-ui/assistant-ui`

- **Commit:** `1aa0a8ce36e50d46d2347311c42a3157de7553ac`
- **License:** MIT
- **Inspected:** `packages/core/src/runtime/utils/chat-model-adapter.ts`, `packages/core/src/runtimes/local/local-runtime-options.ts`, `packages/react-markdown/src/primitives/MarkdownText.tsx`; official current docs for LocalRuntime, Thread, Message, Composer, ActionBar, and MarkdownText.
- **INSPIRED BY:** Thread, message, composer, retry and cancel primitives; the current custom-backend `useLocalRuntime + ChatModelAdapter` integration; cumulative content yields for streamed messages; AbortSignal propagation.
- **IMPLEMENTED IN HUIYI:** a single adapter that POSTs a user turn to the Huiyi Gateway, consumes the Huiyi event contract, and yields cumulative assistant text to LocalRuntime. Citation links are rendered into Huiyi's evidence drawer.
- **NOT COPIED / NOT ADOPTED:** generated shadcn components, AI SDK/LangGraph adapters, hosted provider clients, tool runtimes, or a second agent loop. No upstream files were copied.

## `medplum/medplum-chart-demo`

- **Commit:** `52d0817662455d2f7b3f85fa0bf1730aaceb2747`
- **License:** Apache-2.0
- **Inspected:** `src/pages/PatientPage.tsx`, `src/components/PatientDetails.tsx`.
- **INSPIRED BY:** a chart-like patient context alongside the active encounter, with problems and longitudinal clinical data separated into readable sections.
- **IMPLEMENTED IN HUIYI:** a compact patient column with encounter, conditions, medication, allergies, and a separately styled memory summary.
- **NOT COPIED / NOT ADOPTED:** Medplum backend, hosted APIs, FHIR server, OAuth, FHIR data, or UI source.

## `medplum/foomedical`

- **Commit:** `40adf40a16e48449a6ced322ce0bd3f1405f36c1`
- **License:** Apache-2.0
- **Inspected:** `src/pages/MessagesPage.tsx`, `src/components/InfoSection.tsx`.
- **INSPIRED BY:** patient-facing health record cards, clear messaging hierarchy, and care information grouped into calm, scannable sections.
- **IMPLEMENTED IN HUIYI:** restrained card grouping and a conversation embedded in a clinical work surface.
- **NOT COPIED / NOT ADOPTED:** its backend, messaging service, account model, clinical records, or component source.

## `openmrs/openmrs-esm-patient-chart`

- **Commit:** `9377b46968b541e82eb9e87442feda769092be15`
- **License:** MPL-2.0
- **Inspected:** `packages/esm-patient-chart-app/src/patient-chart/patient-chart.component.tsx`, `packages/esm-patient-banner-app/src/banner/patient-banner.component.tsx`, project README.
- **INSPIRED BY:** longitudinal chart grouping and surfacing allergies, conditions, medications, encounters, vitals, and flags by clinical importance.
- **IMPLEMENTED IN HUIYI:** a short, vertically ordered, synthetic patient context rather than a full chart.
- **NOT COPIED / NOT ADOPTED:** OpenMRS microfrontend runtime, APIs, patient records, or source code.

## Attribution and scope

The four studies informed layout and API choices only. The Huiyi implementation is original code and uses synthetic fixture records. It does not imply compatibility with or endorsement by the referenced projects.

## Clinical workflow, EHR, and evaluation references

The following upstreams were shallow-cloned on 2026-10-10 under `D:\MyLab\Jianli\external` for read-only product research. They were not installed or executed. Commits below pin the checked snapshots; initial review covered their README/license and the indicated API or source surfaces. Upstream metrics and deployment choices are not Huiyi results.

| Project | Local snapshot | License | Product capability reviewed | Huiyi design implication and boundary |
| --- | --- | --- | --- | --- |
| [Medplum](https://github.com/medplum/medplum) | `external/medplum` · `f3bf9049f8077eb1c6a5de66c047ed5fad1c30bd` | Apache-2.0 | FHIR-based clinical data repository/API, OAuth/OpenID/SMART-on-FHIR identity, app SDK and workflow UI. | Use as a reference for a standards-based patient/Encounter context adapter and authorization boundary. Cloning it does not mean Huiyi has a FHIR server or OIDC integration. |
| [OpenEMR](https://github.com/openemr/openemr) | `external/openemr` · `e79ff2230b70e38e884e0951c47e06d6954b7d52` | GPL-3.0 | EHR/practice system; the checked `FHIR_README.md` and `API_README.md` describe FHIR R4, OAuth2/SMART scopes, patient resources and API surfaces. | Study the interaction between EHR identity, scopes and patient resources. Treat the license as a separate adoption constraint; this source is a reference, not a bundled dependency. |
| [OpenEMR-AI](https://github.com/iupui-soic/openemr-ai) | `external/openemr-ai` · `363c463f8ae6e30d9b33d15bde228097c89381d9` | MPL-2.0 | SMART-on-FHIR ambient-listening app; its deployment README describes patient-context launch, note generation and FHIR write-back, with research code on a separate branch. | Study a physician-review/documentation handoff and explicit FHIR write-back boundary. The README's hosted services, model choices and cost/quality figures are upstream claims; do not reuse them as Huiyi measurements. |
| [OpenCHA / CHA](https://github.com/Institute4FutureHealth/CHA) | `external/opencha` · `d6129c4b5eb1dd155e549ee115b8dcb572c19593` | MIT | The checked source/docs show a conversational health-agent interface, a task planner and modular health/data tasks. | Useful comparison for interface ↔ planner ↔ task/source separation. Huiyi must retain its DSH-owned root Session and its separate AMA/RAG contracts; no code was copied. |
| [MedAgentBench](https://github.com/stanfordmlgroup/MedAgentBench) | `external/medagentbench` · `99260117137b09f04837a8c18d18a1107efa55ae` | MIT | Research benchmark with a virtual EHR/FHIR environment and task execution/evaluation harness. Upstream states the code is research-oriented, not necessarily large-scale production software. | Use as a reference for environment-backed clinical tasks, task completion and reproducible evaluator contracts. Do not call its score a Huiyi or clinical deployment result. |
| [Synthea](https://github.com/synthetichealth/synthea) | `external/synthea` · `d9d07a6eef91ee5144293b42ab64224d84d124f8` | Apache-2.0 | Synthetic longitudinal patient population generator with encounters, conditions, medications, observations and FHIR R4 export. | Consider for creating structured longitudinal FHIR test records, subject to local scenario review. It does not by itself simulate an interactive patient over multiple chat turns or clinically validate an Agent. |

The clones use depth-1, blob-filtered sparse checkouts; selected README, docs and source paths were expanded only where needed for this first pass. No package installation, model download, data generation or upstream execution was performed. Before implementing an adapter, do a focused source/API review and record the specific contract, version and licensing implications in an ADR.
