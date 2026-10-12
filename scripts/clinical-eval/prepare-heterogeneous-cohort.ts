import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeSyntheticCohort } from "../../eval/clinical/cohort-audit.js";
import { generateHeterogeneousCohort } from "../../eval/clinical/cohort-heterogeneous-v3.js";
import { validateSyntheticCase } from "../../eval/clinical/cohort.js";
import type { SyntheticClinicalCase } from "../../eval/clinical/contracts.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COHORT_PATH = "artifacts/clinical-eval/cohort-300-heterogeneous-v3.jsonl";
const COVERAGE_PATH = "artifacts/clinical-eval/cohort-300-heterogeneous-v3.coverage.json";
const REVIEW_CSV_PATH = "artifacts/clinical-eval/reviews/cohort-300-heterogeneous-v3-manual-review.csv";
const REVIEW_GUIDE_PATH = "docs/eval/COHORT-300-HETEROGENEOUS-V3-REVIEW.md";

async function main(): Promise<void> {
  const cohort = generateHeterogeneousCohort({ count: 300, seed: 20261012, developmentCount: 30, validationCount: 75 });
  cohort.forEach(validateSyntheticCase);
  auditLongitudinalDisclosures(cohort);
  const content = `${cohort.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const cohortSha256 = sha256(content);
  const scenarioSignatures = new Set(cohort.map((item) => item.scenarioFamily));
  if (cohort.length !== 300 || cohort.some((item) => item.turns.length !== 8)) throw new Error("candidate cohort must have 300 cases and 8 turns per case");
  if (scenarioSignatures.size !== cohort.length) throw new Error(`expected one distinct composite scenario signature per case, got ${scenarioSignatures.size}/${cohort.length}`);
  if (cohort.some((item) => item.clinicalReviewStatus !== "pending" || item.synthetic !== true)) throw new Error("candidate cohort must remain synthetic and pending review");

  const baseCoverage = summarizeSyntheticCohort(cohort);
  const coverage = {
    schemaVersion: "huiyi-heterogeneous-cohort-coverage/v1",
    cohort: COHORT_PATH,
    cohortSha256,
    generator: "synthetic-heterogeneous-v3",
    seed: 20261012,
    generatedAt: new Date().toISOString(),
    reviewStatus: "pending-manual-review",
    clinicalApproval: "not requested; this artifact does not claim clinical validation",
    counts: {
      patients: cohort.length,
      turns: cohort.reduce((sum, item) => sum + item.turns.length, 0),
      facts: cohort.reduce((sum, item) => sum + item.facts.length, 0),
      uniqueCompositeSignatures: scenarioSignatures.size,
      split: countBy(cohort.map((item) => item.split)),
      difficulty: countBy(cohort.map((item) => item.caseDesign!.difficultyTier)),
      encounterCount: countBy(cohort.map((item) => String(item.caseDesign!.encounterCount))),
      crossEncounterHistoryCases: cohort.filter((item) => item.turns.some((turn) => turn.requiredHistoricalFactIds.length > 0)).length,
      casesWithConflicts: cohort.filter((item) => item.caseDesign!.conflictType !== "none-identified").length,
      casesWithRiskEvents: cohort.filter((item) => item.caseDesign!.riskEvent !== "none").length,
      casesWithInformationGaps: cohort.filter((item) => item.caseDesign!.informationGap !== "none-identified").length,
    },
    axes: {
      domain: countBy(cohort.map((item) => item.caseDesign!.domain)),
      trajectory: countBy(cohort.map((item) => item.caseDesign!.trajectory)),
      historyDependency: countBy(cohort.map((item) => item.caseDesign!.historyDependency)),
      communicationStyle: countBy(cohort.map((item) => item.caseDesign!.communicationStyle)),
      informationGap: countBy(cohort.map((item) => item.caseDesign!.informationGap)),
      conflictType: countBy(cohort.map((item) => item.caseDesign!.conflictType)),
      riskEvent: countBy(cohort.map((item) => item.caseDesign!.riskEvent)),
      difficultyBySplit: groupCount(cohort, (item) => item.split, (item) => item.caseDesign!.difficultyTier),
      riskByDifficulty: groupCount(cohort, (item) => item.caseDesign!.difficultyTier, (item) => item.caseDesign!.riskEvent === "none" ? "none" : "present"),
      conflictByDifficulty: groupCount(cohort, (item) => item.caseDesign!.difficultyTier, (item) => item.caseDesign!.conflictType === "none-identified" ? "none" : "present"),
    },
    existingCohortPreservation: {
      legacyArtifact: "artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl",
      action: "retained unchanged; this candidate has a separate path, generator version, and SHA-256",
    },
    existingEngineeringCoverage: baseCoverage,
  };

  const files: Array<[string, string]> = [
    [COHORT_PATH, content],
    [COVERAGE_PATH, `${JSON.stringify(coverage, null, 2)}\n`],
    [REVIEW_CSV_PATH, renderReviewCsv(cohort)],
    [REVIEW_GUIDE_PATH, renderReviewGuide(coverage)],
  ];
  for (const [relativePath, body] of files) {
    const absolutePath = resolve(ROOT, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body, "utf8");
  }
  process.stdout.write(`${JSON.stringify({
    cohort: COHORT_PATH, coverage: COVERAGE_PATH, manualReview: REVIEW_CSV_PATH,
    reviewGuide: REVIEW_GUIDE_PATH, cohortSha256, patients: cohort.length,
    turns: coverage.counts.turns, facts: coverage.counts.facts,
    uniqueCompositeSignatures: scenarioSignatures.size, split: coverage.counts.split,
    difficulty: coverage.counts.difficulty,
    conflicts: coverage.counts.casesWithConflicts, riskEvents: coverage.counts.casesWithRiskEvents,
    clinicalReviewStatus: "pending",
  })}\n`);
}

function auditLongitudinalDisclosures(cases: readonly SyntheticClinicalCase[]): void {
  for (const item of cases) {
    for (const [turnIndex, turn] of item.turns.entries()) {
      const currentlyDisclosed = new Set([
        ...(turn.patientPlan?.initialFactIds ?? []),
        ...(turn.patientPlan?.disclosures.flatMap((entry) => entry.factIds) ?? []),
      ]);
      for (const factId of turn.requiredHistoricalFactIds) {
        if (currentlyDisclosed.has(factId)) throw new Error(`${item.caseId}/${turn.turnId}: prior fact ${factId} is re-disclosed during the recall turn`);
        const wasDisclosedEarlier = item.turns.slice(0, turnIndex).some((earlier) =>
          [...(earlier.patientPlan?.initialFactIds ?? []), ...(earlier.patientPlan?.disclosures.flatMap((entry) => entry.factIds) ?? [])].includes(factId));
        if (!wasDisclosedEarlier) throw new Error(`${item.caseId}/${turn.turnId}: required historical fact ${factId} was never disclosed in an earlier encounter`);
      }
    }
  }
}

function renderReviewCsv(cases: readonly SyntheticClinicalCase[]): string {
  const headings = [
    "case_id", "split", "difficulty", "domain", "trajectory", "history_dependency", "communication_style", "encounter_count",
    "information_gap", "conflict_type", "risk_event", "composite_signature", "history_fact_count",
    "turns_requiring_cross_encounter_facts", "turns_with_evidence_task", "turns_with_risk_task", "expected_task_ids",
    "facts_by_encounter", "turns_for_review", "manual_review_status", "review_notes",
  ];
  const rows = cases.map((item) => {
    const design = item.caseDesign!;
    const encounterIndex = new Map<string, number>();
    item.fhirBundle.entry.filter((entry) => entry.resource.resourceType === "Encounter").forEach((entry, index) => encounterIndex.set(String(entry.resource.id), index + 1));
    const facts = item.facts.filter((fact) => fact.value !== item.patient.privateIsolationCanary)
      .map((fact) => `E${String(encounterIndex.get(fact.encounterId) ?? 0).padStart(2, "0")} [${fact.factId}/${fact.category}] ${fact.label}: ${fact.value}`)
      .join("\n");
    const turns = item.turns.map((turn) => {
      const encounterLabel = `E${String(encounterIndex.get(turn.encounterId) ?? 0).padStart(2, "0")}`;
      const plan = turn.patientPlan;
      const disclosures = plan?.disclosures.map((entry) => `${entry.triggers.join("+")}=>${entry.factIds.join("+")}`).join("; ") ?? "none";
      return [
        `${turn.turnId} ${encounterLabel}`,
        `patientMessage=${turn.patientMessage}`,
        `opening=${plan?.openingMessage ?? ""}`,
        `tasks=${turn.expectedTaskIds.join("+")}`,
        `requiredHistory=${turn.requiredHistoricalFactIds.join("+") || "none"}`,
        `requiredCurrent=${turn.requiredCurrentFactIds.join("+") || "none"}`,
        `risk=${turn.expectedRiskSignalIds.join("+") || "none"}`,
        `evidence=${turn.evidenceTopics.join("+") || "none"}`,
        `initialFacts=${plan?.initialFactIds.join("+") || "none"}`,
        `followUpDisclosure=${disclosures}`,
      ].join(" | ");
    }).join("\n");
    const allTaskIds = [...new Set(item.turns.flatMap((turn) => turn.expectedTaskIds))].join(" | ");
    return [
      item.caseId, item.split, design.difficultyTier, design.domain, design.trajectory, design.historyDependency,
      design.communicationStyle, design.encounterCount, design.informationGap, design.conflictType, design.riskEvent, item.scenarioFamily,
      item.facts.filter((fact) => fact.category === "history" && fact.value !== item.patient.privateIsolationCanary).length,
      item.turns.filter((turn) => turn.requiredHistoricalFactIds.some((factId) => item.facts.find((fact) => fact.factId === factId)?.encounterId !== turn.encounterId)).length,
      item.turns.filter((turn) => turn.expectedTaskIds.includes("retrieve-and-cite-medical-evidence")).length,
      item.turns.filter((turn) => turn.expectedRiskSignalIds.length > 0).length,
      allTaskIds, facts, turns, "not-started", "",
    ];
  });
  return `\uFEFF${[headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderReviewGuide(coverage: Record<string, any>): string {
  const counts = coverage.counts;
  const axes = coverage.axes;
  return `# 300 例异构合成病例候选集：人工审阅说明

## 状态

这是供项目负责人逐例审阅的工程候选数据，不是已通过临床审核的数据，也不是临床建议。300 例均带有合成标记，审批状态保持 pending。没有模型运行或业务效果评分。

- Cohort：\`${COHORT_PATH}\`
- 逐例审阅表：\`${REVIEW_CSV_PATH}\`
- 覆盖统计：\`${COVERAGE_PATH}\`
- SHA-256：\`${coverage.cohortSha256}\`
- 生成器 / seed：\`${coverage.generator}\` / \`${coverage.seed}\`
- 规模：${counts.patients} 例、${counts.turns} 轮、${counts.facts} 条合成事实
- 合成病例组合签名：${counts.uniqueCompositeSignatures} 个

## 和 MedAgentBench / HealthBench 设计的关系

你提供的 \`med.txt\` 强调了医疗 Agent 评测要包含可执行的多步任务、纵向 EHR 上下文、显式任务标准，以及对风险与证据作独立审阅。本候选集借鉴这些评测原则：保留结构化 FHIR 病历、逐轮任务标准和来源线索，同时把患者病例本身做成多维组合。数据并非来自这些论文，也没有复制其病例或得分。

本项目当前重点是跨次复诊中的身份/就诊上下文、历史记忆、资料缺口、信息冲突、医学证据检索和医生审核草稿。候选集使用合成叙述，不宣称达到临床专家撰写基准的可信度。

## 覆盖概况

### 难度与切分

| 维度 | 分布 |
|---|---|
| 开发集 | ${formatCounts(counts.split)} |
| 难度 | ${formatCounts(counts.difficulty)} |
| 就诊次数 | ${formatCounts(counts.encounterCount)} |
| 有跨次历史依赖的病例 | ${counts.crossEncounterHistoryCases} / ${counts.patients} |
| 包含信息冲突 | ${counts.casesWithConflicts} / ${counts.patients} |
| 包含预设风险事件 | ${counts.casesWithRiskEvents} / ${counts.patients} |
| 包含资料缺口 | ${counts.casesWithInformationGaps} / ${counts.patients} |

难度不是临床严重度标签：easy / moderate / hard 表示本评测预设的时间线、信息缺口、来源冲突、风险信号和多次就诊组合复杂度。请人工检查实际病例是否与等级匹配。

### 病种/工作流领域

${markdownCounts(axes.domain)}

### 纵向变化、资料缺口、冲突与风险

| 维度 | 覆盖 |
|---|---|
| 变化轨迹 | ${inlineCounts(axes.trajectory)} |
| 历史依赖 | ${inlineCounts(axes.historyDependency)} |
| 沟通偏好 | ${inlineCounts(axes.communicationStyle)} |
| 资料缺口 | ${inlineCounts(axes.informationGap)} |
| 信息冲突 | ${inlineCounts(axes.conflictType)} |
| 风险事件 | ${inlineCounts(axes.riskEvent)} |

难度与风险交叉：${JSON.stringify(axes.riskByDifficulty)}

难度与冲突交叉：${JSON.stringify(axes.conflictByDifficulty)}

难度在数据切分中的分布：${JSON.stringify(axes.difficultyBySplit)}

## 人工审阅表

在 CSV 中逐例查看完整事实、来源 Encounter、事实类别、8 轮患者脚本/任务标准/披露计划和病例设计维度。建议按以下项目填写末尾两列：

1. 临床叙述是否自洽：时间线、既往记录和本次回忆能否对应；冲突是否明确且没有暗示哪一方必然正确。
2. 难度是否合适：easy 是否确实简单；moderate 是否有一到两个交互难点；hard 是否需要整合多次就诊或同时处理缺口、冲突、风险。
3. 跨就诊依赖是否真实可评：既往事实是否在更早会话中披露，后续任务是否明确要求回忆，而非仅靠当前轮重复输入。
4. 风险信号是否清楚、安全：任务只要求识别并及时升级给医疗人员，不要求模型推断病因、提供处置方案或伪造临床审批。
5. 信息冲突是否可判定：两种来源、时间或说法应能被区分，不能把“资料不足”伪装成事实矛盾。
6. 证据任务是否合理：检索主题需能由医学来源回答；患者自身病史不得被当作医学证据。
7. 是否存在模板化、重复叙述或不自然的合成痕迹；在备注中标注要改写的事实 ID。

## 目前的工程检查

- 每例 8 轮，开发 / 验证 / 留出切分分别为 30 / 75 / 195 例。
- 15 个工作流领域在整个队列中均衡出现；病例签名组合临床领域、变化轨迹、历史依赖、沟通偏好、资料缺口、信息冲突、风险事件、就诊次数和难度，不以固定 12 类场景轮换。
- 每例 2–4 次 FHIR Encounter；Patient、Encounter 和 Observation 引用经结构校验。
- 全部病例仍为 synthetic + pending；隔离 canary 不出现在审阅 CSV 的事实内容中。
- 风险叙述采用升级任务，不给诊断或治疗指令。
- 原 \`cohort-300-adaptive-v2.jsonl\` 与旧评分记录保留原样；此候选集有独立路径和哈希。

## 需要审阅后才能决定的事项

这份数据尚未人工确认临床一致性、任务难度、风险覆盖、对话自然度或是否适合用于宣称业务效果。审完后先修订被指出的病例并重新生成 cohort hash；新队列通过人工审阅之前，不用它运行正式 A/B 或形成简历数字。
`;
}

function countBy(values: readonly string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function groupCount(cases: readonly SyntheticClinicalCase[], group: (item: SyntheticClinicalCase) => string, value: (item: SyntheticClinicalCase) => string): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const item of cases) {
    const outer = group(item);
    const inner = value(item);
    result[outer] ??= {};
    result[outer]![inner] = (result[outer]![inner] ?? 0) + 1;
  }
  return result;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatCounts(value: Record<string, number>): string {
  return Object.entries(value).map(([key, count]) => `${key} ${count}`).join("；");
}

function inlineCounts(value: Record<string, number>): string {
  return Object.entries(value).map(([key, count]) => `\`${key}\` × ${count}`).join("；");
}

function markdownCounts(value: Record<string, number>): string {
  return Object.entries(value).map(([key, count]) => `- \`${key}\`：${count} 例`).join("\n");
}

await main();
