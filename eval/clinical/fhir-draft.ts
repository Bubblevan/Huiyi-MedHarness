import type { ClinicalRunRecord, FhirBundle, SyntheticClinicalCase, SyntheticFact, SyntheticTurn } from "./contracts.js";
import { resourceUrl } from "./cohort.js";

const SYNTHETIC_TAG = { system: "https://huiyi.invalid/fhir/CodeSystem/data-origin", code: "synthetic", display: "Synthetic evaluation data" } as const;
const REVIEW_STATE_EXTENSION = "https://huiyi.invalid/fhir/StructureDefinition/review-workflow-state";
const FIELD_SOURCE_EXTENSION = "https://huiyi.invalid/fhir/StructureDefinition/clinical-draft-source";

/** Build a structured, local-only preliminary Composition; this never writes to an EMR. */
export function createReviewDraftBundle(input: {
  readonly case: SyntheticClinicalCase;
  readonly turn: SyntheticTurn;
  readonly run: ClinicalRunRecord;
}): FhirBundle {
  if (input.run.caseId !== input.case.caseId || input.run.turnId !== input.turn.turnId) throw new TypeError("run, case, and turn do not match");
  if (input.run.status !== "completed" || !input.run.assistantText.trim()) throw new TypeError("only completed non-empty answers can be exported for review");
  if (!input.case.turns.some((turn) => turn.turnId === input.turn.turnId && turn.encounterId === input.turn.encounterId)) throw new TypeError("turn does not belong to the synthetic case");

  const { case: syntheticCase, turn, run } = input;
  const canary = syntheticCase.patient.privateIsolationCanary;
  if ([run.patientMessage, run.assistantText, ...(run.patientSimulation?.transcript.map((item) => item.text) ?? [])].some((text) => text.includes(canary))) {
    throw new TypeError("isolation canary cannot be exported in a clinical draft");
  }
  const visibleFactIds = disclosedFactIds(syntheticCase, run);
  const visibleFacts = syntheticCase.facts.filter((fact) => visibleFactIds.has(fact.factId));
  const compositionId = `draft-${run.runId.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 48)}`;
  const deviceId = `${syntheticCase.patient.patientId}-device`;
  const disclosedMessages = run.patientSimulation?.transcript.filter((item) => item.role === "patient").map((item) => item.text.trim()).filter(Boolean) ?? [];
  const chiefConcern = disclosedMessages.length ? disclosedMessages : [run.patientMessage.trim()].filter(Boolean);
  const history = visibleFacts.filter((fact) => fact.category === "history");
  const currentFacts = visibleFacts.filter((fact) => fact.category === "current" && fact.encounterId === turn.encounterId);
  const medications = visibleFacts.filter((fact) => /用药|药物|服药|剂量/.test(fact.label));
  const allergies = visibleFacts.filter((fact) => /过敏/.test(fact.label));
  const verificationItems = visibleFacts.filter((fact) => /待核实|未提供|不确定|待确认|需核实/.test(`${fact.label} ${fact.value}`));
  const riskFacts = visibleFacts.filter((fact) => fact.category === "risk");

  const sections = [
    section("chief-concern", "主诉与病情变化", chiefConcern.map((message, index) => ({ label: index === 0 ? "患者描述" : `补充描述 ${index}`, value: message })), "patient-message", syntheticCase, turn, run),
    section("history", "既往重要病史", history, "synthetic-case-fact", syntheticCase, turn, run),
    section("medications", "当前用药", medications, "synthetic-case-fact", syntheticCase, turn, run),
    section("allergies", "过敏信息", allergies, "synthetic-case-fact", syntheticCase, turn, run),
    section("symptoms-and-tests", "本次症状与检查摘要", currentFacts, "synthetic-case-fact", syntheticCase, turn, run),
    section("information-to-verify", "待医生核实的信息", verificationItems, "synthetic-case-fact", syntheticCase, turn, run,
      "未列出项目不代表已经核实；请与患者及原始检查记录核对。"),
    section("risk-signals", "记录中的风险相关信息（待核实）", riskFacts, "synthetic-case-fact", syntheticCase, turn, run,
      "此处整理的是合成来源记录，不表示 Agent 已识别风险或完成风险评估。"),
    section("medical-evidence", "医学证据与出处", run.evidence.map((item) => ({
      label: `${item.evidenceId} · ${item.source} · ${item.title}`,
      value: `引用 ID ${item.evidenceId}；排序 ${item.rank}`,
      sourceReference: item.evidenceId,
    })), "medical-evidence", syntheticCase, turn, run, "医学证据与患者历史分栏呈现；引用 ID 用于回查本轮证据记录。"),
    section("assistant-response", "模型生成的本轮回复（未审核）", [{ label: "模型回复", value: run.assistantText }], "assistant-response", syntheticCase, turn, run),
    section("uncertainty", "不确定性与缺失信息", [
      { label: "审核状态", value: "本草稿由模型工作流生成，尚未经过临床人员审核。" },
      { label: "事实边界", value: "只有带有合成来源标识的病例事实列为病史；模型推测不转写为确定事实。" },
      { label: "评测边界", value: "本 Composition 仅用于合成工作流评审，不是诊断、治疗建议或真实 EMR 记录。" },
    ], "workflow", syntheticCase, turn, run),
  ];

  const composition = {
    resourceType: "Composition",
    id: compositionId,
    status: "preliminary",
    type: { text: "Structured synthetic follow-up review draft" },
    subject: { reference: resourceUrl("Patient", syntheticCase.patient.patientId) },
    encounter: { reference: resourceUrl("Encounter", turn.encounterId) },
    date: run.startedAt,
    author: [{ reference: resourceUrl("Device", deviceId) }],
    title: "合成复诊结构化草稿（待医生审核）",
    extension: [{ url: REVIEW_STATE_EXTENSION, valueCode: "preliminary" }],
    section: sections,
    meta: { tag: [SYNTHETIC_TAG] },
  };
  const entry = { fullUrl: resourceUrl("Composition", compositionId), resource: composition };
  const encounterOrder = [...new Set(syntheticCase.turns.map((item) => item.encounterId))];
  const encounterIndex = encounterOrder.indexOf(turn.encounterId);
  const visibleEncounterIds = new Set(encounterOrder.slice(0, encounterIndex + 1));
  const sourceEntries = syntheticCase.fhirBundle.entry.filter(({ resource }) => {
    if (resource.resourceType === "Encounter") return visibleEncounterIds.has(String(resource.id));
    if (resource.resourceType === "Observation") {
      const fact = visibleFacts.find((candidate) => observationMatchesFact(resource, candidate));
      return Boolean(fact);
    }
    if (resource.resourceType === "Condition") {
      const code = isRecord(resource.code) ? resource.code.text : undefined;
      const conditionFact = syntheticCase.facts.find((fact) => fact.category === "current" && fact.label === "本次主要情况" && fact.value === code);
      return !conditionFact || visibleFactIds.has(conditionFact.factId);
    }
    return true;
  });
  return { ...syntheticCase.fhirBundle, entry: [...sourceEntries, entry] };
}

function disclosedFactIds(syntheticCase: SyntheticClinicalCase, run: ClinicalRunRecord): Set<string> {
  const candidates = new Set([
    ...(run.patientSimulation?.disclosedFactIds ?? []),
    ...(run.patientSimulation?.encounterDisclosedFactIds ?? []),
  ]);
  const patientTexts = [
    run.patientMessage,
    ...(run.patientSimulation?.transcript.filter((item) => item.role === "patient").map((item) => item.text) ?? []),
  ];
  for (const fact of syntheticCase.facts) {
    if (fact.value !== syntheticCase.patient.privateIsolationCanary && fact.value.trim() && patientTexts.some((text) => text.includes(fact.value))) {
      candidates.add(fact.factId);
    }
  }
  const canaryFact = syntheticCase.facts.find((fact) => fact.value === syntheticCase.patient.privateIsolationCanary);
  if (canaryFact && candidates.has(canaryFact.factId)) throw new TypeError("isolation canary fact ID cannot be exported in a clinical draft");
  return new Set(syntheticCase.facts.filter((fact) => candidates.has(fact.factId) && fact.value !== syntheticCase.patient.privateIsolationCanary).map((fact) => fact.factId));
}

function observationMatchesFact(resource: Record<string, unknown>, fact: SyntheticFact): boolean {
  if (!isRecord(resource.code) || !isRecord(resource.encounter)) return false;
  const reference = resource.encounter.reference;
  return resource.code.text === fact.label && resource.valueString === fact.value
    && typeof reference === "string" && reference.endsWith(`/Encounter/${fact.encounterId}`);
}

function section(
  code: string,
  title: string,
  items: readonly (SyntheticFact | { readonly label: string; readonly value: string; readonly sourceReference?: string })[],
  sourceKind: string,
  syntheticCase: SyntheticClinicalCase,
  turn: SyntheticTurn,
  run: ClinicalRunRecord,
  note?: string,
) {
  const rows = items.length
    ? items.map((item) => `${item.label}: ${item.value}${"factId" in item ? ` [fact:${item.factId}; encounter:${item.encounterId}]` : ""}`).join("\n")
    : "当前输入中没有此类结构化内容；空项不代表阴性或已完成评估。";
  const references = items.flatMap((item): Array<{ reference: string } | { display: string }> => {
    if ("factId" in item) {
      const sourceEntry = syntheticCase.fhirBundle.entry.find((entry) => {
        const resource = entry.resource;
        return resource.resourceType === "Observation" && isRecord(resource.code) && resource.code.text === item.label
          && resource.valueString === item.value && isRecord(resource.encounter)
          && typeof resource.encounter.reference === "string" && resource.encounter.reference.endsWith(`/Encounter/${item.encounterId}`);
      });
      if (sourceEntry) return [{ reference: sourceEntry.fullUrl }];
      return [{ reference: resourceUrl("Encounter", item.encounterId) }];
    }
    if (item.sourceReference) return [{ display: item.sourceReference }];
    return [];
  });
  const sourceEncounterIds = [...new Set(items.flatMap((item) => "factId" in item ? [item.encounterId] : []))];
  const provenance = {
    url: FIELD_SOURCE_EXTENSION,
    extension: [
      { url: "field", valueCode: code },
      { url: "source-kind", valueCode: sourceKind },
      { url: "source-patient", valueReference: { reference: resourceUrl("Patient", syntheticCase.patient.patientId) } },
      ...(sourceEncounterIds.length ? sourceEncounterIds : [turn.encounterId]).map((encounterId) => ({
        url: "source-encounter", valueReference: { reference: resourceUrl("Encounter", encounterId) },
      })),
      { url: "run", valueString: run.runId },
      { url: "review-disposition", valueCode: "unreviewed" },
    ],
  };
  const narrative = [rows, note].filter(Boolean).join("\n\n");
  return {
    title,
    code: { coding: [{ system: "https://huiyi.invalid/fhir/CodeSystem/clinical-draft-section", code, display: title }] },
    extension: [provenance],
    text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeHtml(narrative).replace(/\r?\n/g, "<br/>")}</div>` },
    ...(references.length ? { entry: references } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
