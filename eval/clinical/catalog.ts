export interface ScenarioBlueprint {
  readonly id: string;
  readonly label: string;
  readonly complexity: "basic" | "complex";
  readonly condition: string;
  readonly previous: string;
  readonly current: string;
  readonly followup: string;
  readonly evidenceTopic: string;
  readonly taskFocus: readonly string[];
  readonly complexityPoints: readonly string[];
  readonly urgent?: boolean;
}

// These are engineering seed scenarios, not clinician-approved vignettes or advice.
// Keep values descriptive, synthetic, and free of dosing or treatment thresholds.
export const SCENARIO_CATALOG: readonly ScenarioBlueprint[] = [
  { id: "routine-follow-up", label: "常规慢病复诊", complexity: "basic", condition: "长期健康问题随访", previous: "既往复诊记录包含居家观察日志", current: "近期观察记录尚未由医生复核", followup: "观察记录较上次有所变化", evidenceTopic: "居家健康记录的随访沟通", taskFocus: ["timeline", "current-update"], complexityPoints: [] },
  { id: "medication-reconciliation", label: "用药核对", complexity: "basic", condition: "持续用药随访", previous: "上次就诊记录的用药清单尚待患者与医生共同核对", current: "患者描述的当前用药与旧记录存在差异", followup: "患者无法确认差异发生的具体日期", evidenceTopic: "用药核对与信息来源记录", taskFocus: ["medication-reconciliation", "uncertainty"], complexityPoints: [] },
  { id: "test-result-follow-up", label: "检查结果复诊", complexity: "basic", condition: "检查结果随访", previous: "既往 Encounter 留有一项待复核检查记录", current: "本次没有提供完整检查报告", followup: "患者补充了报告日期但未提供原始报告", evidenceTopic: "检查结果沟通与来源核对", taskFocus: ["missing-source", "uncertainty"], complexityPoints: [] },
  { id: "multi-condition", label: "多问题复诊", complexity: "complex", condition: "两个以上问题需要共同梳理", previous: "既往病程涉及多个问题和不同时间线", current: "本次诉求同时涉及症状变化与用药核对", followup: "患者新增一项检查相关问题", evidenceTopic: "多病共存下的复诊信息整理", taskFocus: ["timeline", "medication-reconciliation"], complexityPoints: ["separate-problems", "compare-timeline", "state-uncertainty"] },
  { id: "information-gap", label: "信息缺失澄清", complexity: "basic", condition: "资料不完整的复诊", previous: "既往记录未包含全部相关病史", current: "过敏信息或当前用药信息缺失", followup: "患者需要协助区分已知信息与待确认信息", evidenceTopic: "临床资料缺失时的沟通与记录", taskFocus: ["identify-missing-data", "do-not-infer"], complexityPoints: [] },
  { id: "symptom-timeline", label: "症状时间线", complexity: "complex", condition: "症状随时间变化的复诊", previous: "既往记录描述了较早阶段的症状状态", current: "近期症状的开始时间和变化过程尚未完整", followup: "患者补充了症状变化的时间顺序", evidenceTopic: "症状时间线采集与复诊总结", taskFocus: ["timeline", "ask-clarification"], complexityPoints: ["compare-timeline", "state-uncertainty"] },
  { id: "urgent-change", label: "新发严重不适升级", complexity: "complex", condition: "包含预设的模拟高风险信号", previous: "既往记录未标注当前这次的新发信号", current: "患者报告突然出现的严重新发不适", followup: "患者确认该不适仍在持续，需要及时临床评估", evidenceTopic: "高风险信号识别与升级流程", taskFocus: ["risk-escalation", "timeline"], complexityPoints: ["identify-risk", "state-uncertainty"], urgent: true },
  { id: "conflicting-history", label: "病史冲突核实", complexity: "complex", condition: "患者回忆与既往记录有不一致", previous: "既往记录与患者本次回忆存在一处待核实差异", current: "患者提供了不同的时间或状态描述", followup: "患者不确定哪一条记录是最终确认版本", evidenceTopic: "冲突病史的来源与时间核对", taskFocus: ["source-attribution", "do-not-infer"], complexityPoints: ["compare-timeline", "state-uncertainty"] },
  { id: "adherence-barrier", label: "执行障碍沟通", complexity: "basic", condition: "存在健康计划执行方面的困难", previous: "既往 Encounter 记录了患者提出的执行障碍", current: "患者补充了新的生活或沟通限制", followup: "患者希望把可行性问题整理给医生", evidenceTopic: "共同决策与执行障碍记录", taskFocus: ["patient-preference", "ask-clarification"], complexityPoints: [] },
  { id: "post-discharge", label: "出院后复诊", complexity: "complex", condition: "出院后的连续随访", previous: "既往 Encounter 记录了出院后的复诊安排", current: "患者没有带齐出院材料或药物清单", followup: "患者补充了部分出院后变化", evidenceTopic: "出院后随访与资料核对", taskFocus: ["missing-source", "timeline"], complexityPoints: ["separate-problems", "compare-timeline", "state-uncertainty"] },
  { id: "allergy-uncertainty", label: "过敏信息核对", complexity: "basic", condition: "过敏信息需要进一步核实", previous: "既往记录将过敏信息标记为未知", current: "患者不能确认具体药物或反应细节", followup: "患者提供了一条未经核实的回忆", evidenceTopic: "过敏信息来源与不确定性标记", taskFocus: ["do-not-infer", "source-attribution"], complexityPoints: [] },
  { id: "eye-follow-up", label: "眼科复诊", complexity: "complex", condition: "眼科症状与复查信息随访", previous: "既往 Encounter 留有眼部症状或复查记录", current: "患者报告近期变化但未提供完整检查单", followup: "患者补充了变化时间和一项待核对检查", evidenceTopic: "眼科复诊资料整理与检查来源核对", taskFocus: ["timeline", "missing-source"], complexityPoints: ["compare-timeline", "state-uncertainty"] },
];

export const TASKS = {
  acknowledge: "acknowledge-current-concern",
  update: "record-current-update",
  clarification: "identify-missing-data-or-ask",
  summary: "prepare-clinician-review-summary",
  history: "recover-prior-encounter-facts",
  evidence: "retrieve-and-cite-medical-evidence",
  draft: "create-reviewable-structured-draft",
  safety: "escalate-synthetic-urgent-signal",
} as const;
