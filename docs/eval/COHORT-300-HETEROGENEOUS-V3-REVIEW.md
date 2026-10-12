# 300 例异构合成病例候选集：人工审阅说明

## 状态

这是供项目负责人逐例审阅的工程候选数据，不是已通过临床审核的数据，也不是临床建议。300 例均带有合成标记，审批状态保持 pending。没有模型运行或业务效果评分。

- Cohort：`artifacts/clinical-eval/cohort-300-heterogeneous-v3.jsonl`
- 逐例审阅表：`artifacts/clinical-eval/reviews/cohort-300-heterogeneous-v3-manual-review.csv`
- 覆盖统计：`artifacts/clinical-eval/cohort-300-heterogeneous-v3.coverage.json`
- SHA-256：`704ac38d51afaf755b41cc1ea95bb7fcc38cb5ffb846af4161cd1c52a3ea6b88`
- 生成器 / seed：`synthetic-heterogeneous-v3` / `20261012`
- 规模：300 例、2400 轮、2181 条合成事实
- 合成病例组合签名：300 个

## 和 MedAgentBench / HealthBench 设计的关系

你提供的 `med.txt` 强调了医疗 Agent 评测要包含可执行的多步任务、纵向 EHR 上下文、显式任务标准，以及对风险与证据作独立审阅。本候选集借鉴这些评测原则：保留结构化 FHIR 病历、逐轮任务标准和来源线索，同时把患者病例本身做成多维组合。数据并非来自这些论文，也没有复制其病例或得分。

本项目当前重点是跨次复诊中的身份/就诊上下文、历史记忆、资料缺口、信息冲突、医学证据检索和医生审核草稿。候选集使用合成叙述，不宣称达到临床专家撰写基准的可信度。

## 覆盖概况

### 难度与切分

| 维度 | 分布 |
|---|---|
| 开发集 | development 30；held-out 195；validation 75 |
| 难度 | easy 60；hard 90；moderate 150 |
| 就诊次数 | 2 168；3 87；4 45 |
| 有跨次历史依赖的病例 | 300 / 300 |
| 包含信息冲突 | 99 / 300 |
| 包含预设风险事件 | 61 / 300 |
| 包含资料缺口 | 245 / 300 |

难度不是临床严重度标签：easy / moderate / hard 表示本评测预设的时间线、信息缺口、来源冲突、风险信号和多次就诊组合复杂度。请人工检查实际病例是否与等级匹配。

### 病种/工作流领域

- `allergy-history`：20 例
- `care-coordination`：20 例
- `eye-symptoms`：20 例
- `glucose-followup`：20 例
- `headache-course`：20 例
- `home-observation`：20 例
- `imaging-followup`：20 例
- `lab-result-review`：20 例
- `medication-reconciliation`：20 例
- `medication-tolerance`：20 例
- `pain-function`：20 例
- `post-discharge`：20 例
- `respiratory-course`：20 例
- `sleep-fatigue`：20 例
- `wound-followup`：20 例

### 纵向变化、资料缺口、冲突与风险

| 维度 | 覆盖 |
|---|---|
| 变化轨迹 | `fluctuating` × 42；`improving` × 34；`new-feature` × 52；`recurrent` × 56；`stable` × 68；`worsening` × 48 |
| 历史依赖 | `deferred-result` × 39；`event-sequence` × 59；`medication-change` × 46；`multi-visit-trend` × 31；`patient-goal` × 71；`prior-plan` × 54 |
| 沟通偏好 | `confirmed-vs-pending` × 46；`readback-first` × 55；`separate-problems` × 54；`short-question-list` × 50；`source-attribution` × 54；`timeline-first` × 41 |
| 资料缺口 | `allergy-status-unknown` × 29；`baseline-unavailable` × 38；`event-date-uncertain` × 50；`medication-list-incomplete` × 31；`none-identified` × 55；`original-report-missing` × 54；`patient-recall-limited` × 43 |
| 信息冲突 | `date-disagreement` × 21；`medication-list-disagreement` × 26；`none-identified` × 201；`report-version-disagreement` × 22；`status-disagreement` × 30 |
| 风险事件 | `new-breathing-difficulty` × 10；`new-neurologic-change` × 5；`none` × 239；`post-procedure-change` × 5；`sudden-severe-discomfort` × 41 |

难度与风险交叉：{"moderate":{"none":144,"present":6},"hard":{"present":55,"none":35},"easy":{"none":60}}

难度与冲突交叉：{"moderate":{"none":109,"present":41},"hard":{"present":58,"none":32},"easy":{"none":60}}

难度在数据切分中的分布：{"held-out":{"moderate":92,"hard":63,"easy":40},"validation":{"easy":13,"moderate":42,"hard":20},"development":{"moderate":16,"hard":7,"easy":7}}

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
- 原 `cohort-300-adaptive-v2.jsonl` 与旧评分记录保留原样；此候选集有独立路径和哈希。

## 需要审阅后才能决定的事项

这份数据尚未人工确认临床一致性、任务难度、风险覆盖、对话自然度或是否适合用于宣称业务效果。审完后先修订被指出的病例并重新生成 cohort hash；新队列通过人工审阅之前，不用它运行正式 A/B 或形成简历数字。
