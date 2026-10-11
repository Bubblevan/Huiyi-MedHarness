import type { PatientQuestionIntent, SyntheticClinicalCase, SyntheticFact, SyntheticTurn } from "./contracts.js";

export interface PatientSimulatorMessage {
  readonly message: string;
  readonly disclosedFactIds: readonly string[];
  readonly matchedIntents: readonly PatientQuestionIntent[];
  readonly kind: "opening" | "follow-up";
}

const INTENT_PATTERNS: Readonly<Record<PatientQuestionIntent, readonly RegExp[]>> = {
  "chief-concern": [/主要问题|哪里不舒服|什么症状|当前症状|本次情况|具体困扰|chief concern|current symptoms/i],
  timeline: [/时间|几天|几周|何时|什么时候|多久|持续|变化|先后|频率|开始|timeline|how long|when did/i],
  "prior-history": [/既往|之前|上次|病史|历史记录|prior history|medical history/i],
  medication: [/用药|药物|服药|药名|药品|剂量|药物清单|medication|medicine|drug|dose/i],
  allergy: [/过敏|不良反应|allerg|adverse reaction/i],
  source: [/来源|原始报告|检查报告|记录日期|哪条记录|依据哪|source|original report/i],
  preference: [/沟通偏好|希望如何|更喜欢|偏好|preferred format|preference/i],
  safety: [/仍在持续|是否持续|严重程度|突然|急迫|危险信号|紧急|red flag|urgent|emergency/i],
};

/** Deterministic, replayable synthetic patient. It emits only facts explicitly allowed by the active turn plan. */
export class SyntheticPatientSimulator {
  private readonly factById: ReadonlyMap<string, SyntheticFact>;
  private readonly disclosed = new Set<string>();
  private active?: { readonly turn: SyntheticTurn; followUps: number; readonly maxFollowUps: number };

  constructor(private readonly patient: SyntheticClinicalCase, private readonly options: { readonly maxFollowUpMessages?: number } = {}) {
    if (options.maxFollowUpMessages !== undefined && (!Number.isSafeInteger(options.maxFollowUpMessages) || options.maxFollowUpMessages < 0 || options.maxFollowUpMessages > 5)) {
      throw new RangeError("patient simulator follow-up limit must be between 0 and 5");
    }
    this.factById = new Map(patient.facts.map((fact) => [fact.factId, fact]));
  }

  startTurn(turn: SyntheticTurn): PatientSimulatorMessage {
    const plan = turn.patientPlan;
    if (!plan) throw new TypeError(`turn ${turn.turnId} has no adaptive patient plan`);
    if (!this.patient.turns.some((candidate) => candidate.turnId === turn.turnId)) throw new TypeError("turn does not belong to this synthetic patient");
    const allowed = new Set([...turn.requiredHistoricalFactIds, ...turn.requiredCurrentFactIds, ...turn.expectedRiskSignalIds]);
    const planned = [...plan.initialFactIds, ...plan.disclosures.flatMap((rule) => rule.factIds)];
    if (new Set(planned).size !== planned.length) throw new TypeError(`patient plan for ${turn.turnId} repeats a fact`);
    for (const factId of planned) {
      if (!allowed.has(factId)) throw new TypeError(`patient plan for ${turn.turnId} reveals a fact outside the turn's allowed disclosures`);
      const fact = this.factById.get(factId);
      if (!fact || fact.value === this.patient.patient.privateIsolationCanary) throw new TypeError(`patient plan for ${turn.turnId} refers to an unavailable fact`);
    }
    if (!Number.isSafeInteger(plan.maxFollowUpMessages) || plan.maxFollowUpMessages < 0 || plan.maxFollowUpMessages > 5) {
      throw new RangeError("patient plan follow-up limit must be between 0 and 5");
    }

    const maxFollowUps = Math.min(plan.maxFollowUpMessages, this.options.maxFollowUpMessages ?? plan.maxFollowUpMessages);
    this.active = { turn, followUps: 0, maxFollowUps };
    const facts = plan.initialFactIds.filter((factId) => !this.disclosed.has(factId)).map((factId) => this.factById.get(factId)!);
    for (const fact of facts) this.disclosed.add(fact.factId);
    return {
      message: renderPatientMessage(plan.openingMessage, facts),
      disclosedFactIds: facts.map((fact) => fact.factId),
      matchedIntents: [],
      kind: "opening",
    };
  }

  respondToAssistant(assistantText: string): PatientSimulatorMessage | undefined {
    if (!this.active) throw new Error("startTurn must be called before responding to the assistant");
    const { turn, followUps, maxFollowUps } = this.active;
    const plan = turn.patientPlan!;
    if (followUps >= maxFollowUps) return undefined;
    const matchedIntents = detectPatientQuestionIntents(assistantText);
    const factIds = plan.disclosures
      .filter((rule) => rule.triggers.some((intent) => matchedIntents.includes(intent)))
      .flatMap((rule) => rule.factIds)
      .filter((factId) => !this.disclosed.has(factId));
    if (!factIds.length) return undefined;
    const facts = factIds.map((factId) => this.factById.get(factId)!).filter(Boolean);
    if (facts.length !== factIds.length) throw new TypeError(`patient plan for ${turn.turnId} refers to an unknown disclosure fact`);
    for (const fact of facts) this.disclosed.add(fact.factId);
    this.active = { turn, followUps: followUps + 1, maxFollowUps };
    return {
      message: renderPatientMessage("补充一下：", facts),
      disclosedFactIds: facts.map((fact) => fact.factId),
      matchedIntents,
      kind: "follow-up",
    };
  }
}

export function detectPatientQuestionIntents(assistantText: string): PatientQuestionIntent[] {
  const intents = (Object.keys(INTENT_PATTERNS) as PatientQuestionIntent[])
    .filter((intent) => INTENT_PATTERNS[intent].some((pattern) => pattern.test(assistantText)));
  return intents;
}

function renderPatientMessage(prefix: string, facts: readonly SyntheticFact[]): string {
  if (!facts.length) return prefix.trim();
  const disclosures = facts.map((fact) => `${fact.label}：${fact.value}`).join("；");
  return `${prefix}${prefix.endsWith("：") ? "" : " "}${disclosures}。`;
}
