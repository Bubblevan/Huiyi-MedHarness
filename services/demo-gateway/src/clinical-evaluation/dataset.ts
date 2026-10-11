import { createHash } from "node:crypto";
import type { PatientContext } from "../contracts.js";

export const SYNTHETIC_DATASET_SCHEMA_VERSION = "1.0.0";

export interface SyntheticDisclosure {
  readonly turn: number;
  readonly patientMessage: string;
  readonly factToDisclose: string;
}

export interface SyntheticEncounter {
  readonly encounterId: string;
  readonly label: string;
  readonly status: "finished" | "in-progress";
  readonly summary: string;
  readonly turnPlan: readonly SyntheticDisclosure[];
}

export type SyntheticEncounterSummary = Omit<SyntheticEncounter, "turnPlan">;

export interface SyntheticPatientRecord extends PatientContext {
  readonly synthetic: true;
  readonly tenantId: string;
  readonly accessGroup: string;
  readonly encounters: readonly SyntheticEncounter[];
}

export interface SyntheticDatasetOptions {
  readonly patientCount?: number;
  readonly turnCount?: number;
  readonly seed?: string;
  readonly encounterCount?: number;
}

export interface PatientAccessScope {
  readonly tenantId: string;
  readonly role: "clinician" | "administrator";
  readonly accessGroup: string;
}

const conditionSets = [
  { condition: "高血压随访", medication: "长期用药记录 A", allergy: "未发现已记录药物过敏", memory: "既往复诊关注居家血压记录与规律随访。" },
  { condition: "血脂异常随访", medication: "长期用药记录 B", allergy: "过敏史待核实", memory: "既往记录提示需要核对检查日期与生活方式变化。" },
  { condition: "糖代谢异常随访", medication: "长期用药记录 C", allergy: "未发现已记录药物过敏", memory: "既往复诊关注症状变化、检测结果时间点与用药依从性。" },
  { condition: "慢性咳嗽复诊", medication: "长期用药记录 D", allergy: "过敏史未提供", memory: "既往记录包含症状持续时间及诱因，需在本次就诊核对。" },
] as const;

const disclosurePairs = [
  ["最近开始出现新的不适，想确认本次需要补充哪些情况。", "症状出现的具体时间尚未核实。"],
  ["我可以再补充一下这段时间的变化。", "症状频率和严重程度需要进一步询问。"],
  ["之前检查过一次，但不确定报告日期。", "检查报告的日期与结果需要从原始记录确认。"],
  ["最近的用药情况和之前不完全一样。", "当前实际用药与处方记录需要核对。"],
  ["还有一项可能重要的信息，我刚想起来。", "新增信息应由临床人员核验后纳入病史。"],
  ["我暂时没有更多资料了。", "仍有未确认信息，不应由系统推断补全。"],
] as const;

function digest(seed: string, value: string): Buffer {
  return createHash("sha256").update(`${seed}\0${value}`).digest();
}

function makeTurnPlan(seed: string, patientNo: number, turnCount: number): SyntheticDisclosure[] {
  return Array.from({ length: turnCount }, (_, index) => {
    const pair = disclosurePairs[digest(seed, `${patientNo}:turn:${index}`).readUInt32BE(0) % disclosurePairs.length]!;
    return { turn: index + 1, patientMessage: pair[0], factToDisclose: pair[1] };
  });
}

function cloneSyntheticPatient(patient: SyntheticPatientRecord): SyntheticPatientRecord {
  return {
    patientId: patient.patientId,
    tenantId: patient.tenantId,
    accessGroup: patient.accessGroup,
    displayName: patient.displayName,
    age: patient.age,
    sex: patient.sex,
    encounterId: patient.encounterId,
    encounter: patient.encounter,
    conditions: [...patient.conditions],
    medications: [...patient.medications],
    allergies: [...patient.allergies],
    memory: { ...patient.memory },
    suggestedQuestion: patient.suggestedQuestion,
    synthetic: true,
    encounters: patient.encounters.map((encounter) => ({
      encounterId: encounter.encounterId,
      label: encounter.label,
      status: encounter.status,
      summary: encounter.summary,
      turnPlan: encounter.turnPlan.map((disclosure) => ({ ...disclosure })),
    })),
  };
}

export function generateSyntheticPatients(options: SyntheticDatasetOptions = {}): SyntheticPatientRecord[] {
  const patientCount = options.patientCount ?? 300;
  const turnCount = options.turnCount ?? 8;
  const encounterCount = options.encounterCount ?? 3;
  const seed = options.seed ?? "huiyi-clinical-evaluation-v1";
  if (!Number.isSafeInteger(patientCount) || patientCount < 1 || patientCount > 10_000) throw new RangeError("patientCount must be between 1 and 10000");
  if (!Number.isSafeInteger(turnCount) || turnCount < 1 || turnCount > 100) throw new RangeError("turnCount must be between 1 and 100");
  if (!Number.isSafeInteger(encounterCount) || encounterCount < 1 || encounterCount > 20) throw new RangeError("encounterCount must be between 1 and 20");
  if (!seed.trim() || seed.length > 200) throw new TypeError("seed must contain 1 to 200 characters");

  return Array.from({ length: patientCount }, (_, offset) => {
    const index = offset + 1;
    const patientNo = String(index).padStart(4, "0");
    const caseType = conditionSets[digest(seed, `${index}:profile`).readUInt32BE(0) % conditionSets.length]!;
    const age = 20 + digest(seed, `${index}:age`).readUInt16BE(0) % 65;
    const encounters = Array.from({ length: encounterCount }, (_, encounterOffset) => {
      const number = encounterOffset + 1;
      return {
        encounterId: `SYN-${patientNo}-ENC-${String(number).padStart(2, "0")}`,
        label: number === encounterCount ? "当前模拟复诊" : `既往模拟就诊 ${number}`,
        status: number === encounterCount ? "in-progress" as const : "finished" as const,
        summary: number === encounterCount ? "当前就诊信息由使用者逐步补充并由临床人员核对。" : caseType.memory,
        turnPlan: makeTurnPlan(seed, index * 31 + number, turnCount),
      };
    });
    const tenantNumber = index % 2 === 0 ? 2 : 1;
    const cohortNumber = Math.floor((index - 1) / 2) % 2 === 0 ? "a" : "b";
    const currentEncounter = encounters.at(-1)!;
    const profileDigest = digest(seed, `${index}:identity`);
    return {
      patientId: `SYN-P-${patientNo}`,
      tenantId: `evaluation-tenant-${tenantNumber}`,
      accessGroup: `cohort-${cohortNumber}`,
      displayName: `模拟患者 ${patientNo}`,
      age,
      sex: profileDigest[0]! % 2 === 0 ? "女" : "男",
      encounterId: currentEncounter.encounterId,
      encounter: currentEncounter.label,
      conditions: [caseType.condition],
      medications: [caseType.medication],
      allergies: [caseType.allergy],
      memory: { summary: caseType.memory, items: encounterCount + 1, updatedLabel: "评测数据" },
      suggestedQuestion: "请描述本次复诊最希望讨论的问题。",
      synthetic: true,
      encounters,
    };
  });
}

export class SyntheticEvaluationDataset {
  private readonly records = new Map<string, SyntheticPatientRecord>();

  constructor(readonly options: SyntheticDatasetOptions = {}, records?: readonly SyntheticPatientRecord[]) {
    for (const patient of records ?? generateSyntheticPatients(options)) {
      if (patient.synthetic !== true || !patient.patientId || this.records.has(patient.patientId)) {
        throw new TypeError("Evaluation dataset records must be unique and explicitly synthetic");
      }
      // Do not retain caller-owned objects: these fields define the authorization scope.
      this.records.set(patient.patientId, cloneSyntheticPatient(patient));
    }
    if (!this.records.size) throw new TypeError("Evaluation dataset must contain at least one synthetic patient");
  }

  listPatients(scope: PatientAccessScope): Array<{
    patientId: string; displayName: string; age: number; sex: string; synthetic: true; encounters: SyntheticEncounterSummary[];
  }> {
    return [...this.records.values()].filter((patient) => canAccessSyntheticPatient(scope, patient)).map((patient) => ({
      patientId: patient.patientId,
      displayName: patient.displayName,
      age: patient.age,
      sex: patient.sex,
      synthetic: true,
      encounters: patient.encounters.map(({ turnPlan: _privateTurnPlan, ...summary }) => summary),
    }));
  }

  getPatient(patientId: string, scope: PatientAccessScope): SyntheticPatientRecord | undefined {
    const patient = this.records.get(patientId);
    return patient && canAccessSyntheticPatient(scope, patient) ? cloneSyntheticPatient(patient) : undefined;
  }

  getPatientForBackend(patientId: string, encounterId: string | undefined): PatientContext | undefined {
    const patient = this.records.get(patientId);
    if (!patient) return undefined;
    const encounterIndex = patient.encounters.findIndex((item) => item.encounterId === encounterId);
    if (encounterIndex < 0) return undefined;
    const encounter = patient.encounters[encounterIndex]!;
    return {
      patientId: patient.patientId,
      tenantId: patient.tenantId,
      encounterId: encounter.encounterId,
      synthetic: true,
      displayName: patient.displayName,
      age: patient.age,
      sex: patient.sex,
      encounter: encounter.label,
      conditions: [...patient.conditions],
      medications: [...patient.medications],
      allergies: [...patient.allergies],
      encounterHistory: patient.encounters.slice(0, encounterIndex).map(({ encounterId: priorEncounterId, label, status, summary }) => ({
        encounterId: priorEncounterId,
        label,
        status,
        summary,
      })),
      memory: { ...patient.memory },
      suggestedQuestion: patient.suggestedQuestion,
    };
  }

  getEncounterSummaries(patientId: string, scope: PatientAccessScope): SyntheticEncounterSummary[] | undefined {
    const patient = this.getPatient(patientId, scope);
    return patient?.encounters.map(({ turnPlan: _privateTurnPlan, ...summary }) => summary);
  }
}

export function canAccessSyntheticPatient(scope: PatientAccessScope, patient: SyntheticPatientRecord): boolean {
  return patient.tenantId === scope.tenantId && (scope.role === "administrator" || patient.accessGroup === scope.accessGroup);
}
