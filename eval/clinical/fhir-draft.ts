import type { ClinicalRunRecord, FhirBundle, SyntheticClinicalCase, SyntheticTurn } from "./contracts.js";
import { resourceUrl } from "./cohort.js";

const SYNTHETIC_TAG = { system: "https://huiyi.invalid/fhir/CodeSystem/data-origin", code: "synthetic", display: "Synthetic evaluation data" } as const;

/** Create a local-only, preliminary FHIR Composition. This function never writes to an EMR. */
export function createReviewDraftBundle(input: {
  readonly case: SyntheticClinicalCase;
  readonly turn: SyntheticTurn;
  readonly run: ClinicalRunRecord;
}): FhirBundle {
  if (input.run.caseId !== input.case.caseId || input.run.turnId !== input.turn.turnId) throw new TypeError("run, case, and turn do not match");
  if (input.run.status !== "completed" || !input.run.assistantText.trim()) throw new TypeError("only completed non-empty answers can be exported for review");
  const compositionId = `draft-${input.run.runId.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 48)}`;
  const deviceId = `${input.case.patient.patientId}-device`;
  const composition = {
    resourceType: "Composition",
    id: compositionId,
    status: "preliminary",
    type: { text: "Synthetic clinical workflow review draft" },
    subject: { reference: resourceUrl("Patient", input.case.patient.patientId) },
    encounter: { reference: resourceUrl("Encounter", input.turn.encounterId) },
    date: input.run.startedAt,
    author: [{ reference: resourceUrl("Device", deviceId) }],
    title: "供执业医师审核的合成复诊草稿",
    section: [{
      title: "助手草稿（未经临床审核）",
      text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeHtml(input.run.assistantText).replace(/\r?\n/g, "<br/>")}</div>` },
    }],
    meta: { tag: [SYNTHETIC_TAG] },
  };
  const entry = { fullUrl: resourceUrl("Composition", compositionId), resource: composition };
  return { ...input.case.fhirBundle, entry: [...input.case.fhirBundle.entry, entry] };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
