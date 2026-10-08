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
