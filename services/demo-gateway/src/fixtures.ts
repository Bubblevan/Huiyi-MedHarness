import type { PatientContext } from "./contracts.js";

export const patients: PatientContext[] = [
  {
    patientId: "patient-htn",
    displayName: "张某",
    age: 52,
    sex: "男",
    encounter: "高血压复诊 · 2026-10-09",
    conditions: ["高血压（合成示例）"],
    medications: ["示例降压药 · 每日一次"],
    allergies: ["无已知药物过敏（合成示例）"],
    memory: { summary: "上次复诊提到居家测量血压；偏好简短、分步骤的说明。", items: 6, updatedLabel: "上次复诊" },
    suggestedQuestion: "最近一周居家血压有几次偏高，我需要怎么记录并和医生讨论？",
  },
  {
    patientId: "patient-complex",
    displayName: "李某",
    age: 67,
    sex: "女",
    encounter: "复杂病例讨论 · 2026-10-09",
    conditions: ["高血压（合成示例）", "2 型糖尿病（合成示例）"],
    medications: ["示例药物 A · 方案需核对", "示例药物 B · 方案需核对"],
    allergies: ["待本次演示核实"],
    memory: { summary: "既往记录包含血压与血糖随访；本演示用来呈现多专科协作状态。", items: 11, updatedLabel: "合成病程摘要" },
    suggestedQuestion: "请帮我整理这次复诊中需要进一步核实的血压和血糖问题。",
  },
];

export function getPatient(patientId: string): PatientContext | undefined {
  return patients.find((patient) => patient.patientId === patientId);
}
