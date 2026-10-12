# B3｜记忆与复杂协作：现有证据结论

**状态：`INSUFFICIENT_EVIDENCE`（单项效果归因不足）。** 已有记录足以报告 AMA 的事实级召回机制数据和一次复杂协作流程 smoke；不足以声称 AMA 提升了跨次病史正确引用率，也不足以声称多专家协作提高了复杂病例关键点覆盖率。本次只分析既有产物，没有发起模型调用。

## 冻结样本与版本

- **运行：** `20261011184053-5bce7818`，最终记录 80 条：Single 40 条、Integrated 40 条；5 个合成纵向病例（HCE-0001–HCE-0005），development split，GPT-6-Luna / Codex app-server。
- **源码：** Git revision `0c7ddc93df99cbe92cc4ac4b25ba34c933e376b0`；冻结源码 fingerprint `18190a8bc8a597664ed0f4eddf475dc264d6baa958815d915c22618d0296156d`，运行 manifest 标记相关工作树干净。
- **病例 Cohort：** SHA-256 `7d70893f2ffab9f8711f5ac260a1f70729bef758fb41f7cae50afaa894a6310c`。
- **归因限制：** Integrated 同时开启 AMA、RAG 和临床协作；Single 同时关闭三项。因此臂间差不能归因给记忆或协作。

## 可支持的 AMA 事实级结果

| 观测项 | 结果 | 可解释范围 |
|---|---:|---|
| 跨 Encounter 召回机会 | 20 次机会，来自 5 个唯一合成事实 ID | 同一事实可在多轮重复形成机会，20 不是 20 个独立事实 |
| AMA 精确事实 ID 命中 | 5/20（25.0%） | 仅表示 AMA 返回记录与预先标注的可召回事实 ID 相交 |
| 被命中事实在当轮回答中的精确回显 | 0/5（0%） | 对命中的 5 个跨 Encounter 事实，`echoedInAssistant` 均为 false |
| AMA automatic recall 操作 | 13/14 完成，1/14 失败 | 排除 59 条被策略跳过的记录后计算；为运行机制状态，不是临床正确率 |
| AMA commit 操作 | 19/22 完成，3/22 失败 | 排除 61 条批次尚未到期而跳过的记录后计算 |
| Integrated 中记录的 recalled fact 条目 | 25 条，4 条在回答文本中精确回显 | 包含所有事实，不限于跨 Encounter 合格事实；不能称作 4 条正确病史引用 |
| Single 记忆调用 | 0 次 | 符合 Single 臂关闭 AMA 的配置，不构成同质量的记忆 A/B 评测 |

冻结运行现有 `memoryUsage.recalledFacts` 含 `factId`、AMA `sourceId`、操作类型和 `echoedInAssistant` 标志，可支持上述可复核的机制统计。它没有将语义等价表达、错误记忆、来源事实正确性或回答中的临床主张作盲审判定。运行评分报告自身也将这组数据定义为机制遥测，而非临床正确性。

**不能从该运行推出：** AMA 将历史事实正确引用率从 A 提高到 B、AMA 事实召回准确率、跨患者记忆零泄漏、虚假记忆率，或患者授权隔离有效率。运行的跨患者记忆隔离探针为 `not-run`，探针数为 0。

## 可支持的复杂协作流程结果

| 来源 | 观测结果 | 不能据此声称 |
|---|---|---|
| 冻结 B1 Integrated 臂 | 40 条任务中 5 条调用 `consult_clinical_team`，5/5 工具调用完成；观察到 10/10 个预期子 Agent session，归因完整。Single 臂没有协作调用。 | 两臂同时存在 AMA/RAG 差异；没有冻结复杂病例关键点覆盖评分，不能报告协作收益或净提升。 |
| 本地工程 smoke `smoke-20261011072415-002cc43c` | 一个预选合成病例的协作执行含 7/7 个已完成 child run、0 失败、`degraded=false`；GPT-6-Luna，带认证 Gateway。 | 单病例 smoke 没有单 Agent 对照，也没有关键点盲评；其 147.9 秒是两轮综合 smoke 耗时，不是协作专属延迟。 |

Smoke 同时包含医学证据检索；它只证明当时配置下的调用链可以执行，不是独立协作实验。B1 Integrated 的协作任务耗时从 20.5 秒到 115.2 秒不等，但这些回合还受 AMA、RAG 和任务内容影响，不作为协作延迟基准。

## 最小后续隔离实验方案（未执行）

### AMA memory-only A/B

1. 固定 8 个跨 Encounter 合成任务，预先冻结每题应召回事实 ID；从 Cohort 固定顺序选题，不按已知答题结果筛选。
2. 两臂使用同一 GPT-6-Luna、同一输入、同一患者/就诊最小上下文；关闭 RAG 与协作。A 关闭 AMA，B 只开启 AMA。避免把完整旧 Encounter 摘要直接放入任一臂上下文。
3. 记录每题的事实 ID 命中、回答正确使用、错误/过期记忆断言、跨患者 canary 泄漏、完成状态、延迟与实际观测 token；失败任务留在分母，不重试。
4. 输出逐题配对数据和配对差，不把模型辅助判断称为真人临床审核。

### 复杂协作隔离 A/B

固定 6 个预先标记为复杂的合成任务和关键点清单；两臂都关闭 AMA/RAG，A 单 Agent，B 使用受限路由协作。盲化评分臂别，逐项记录关键点覆盖、工具/子 Agent 完成、降级、失败、延迟和实际观测 token。该方案尚未执行，不存在可报告的效果值。

## 可复核产物

- 冻结运行：[manifest.json](../../artifacts/clinical-eval/runs/20261011184053-5bce7818/manifest.json)、[runs.jsonl](../../artifacts/clinical-eval/runs/20261011184053-5bce7818/runs.jsonl)、[memory-trace.jsonl](../../artifacts/clinical-eval/runs/20261011184053-5bce7818/memory-trace.jsonl)、[score-report.json](../../artifacts/clinical-eval/runs/20261011184053-5bce7818/score-report.json)。
- 协作流程 smoke：[smoke-20261011072415-002cc43c.json](../../artifacts/clinical-eval/smokes/smoke-20261011072415-002cc43c.json)。
- 独立患者授权 sweep 不等于 AMA 记忆隔离，见 [BULLET5-EVIDENCE.md](BULLET5-EVIDENCE.md)。

**B3 决定：`INSUFFICIENT_EVIDENCE`。** 可写“实现并记录 AMA 来源级事实召回追踪及 DSH 多 Agent 协作执行链路”；当前证据不支持写记忆质量提升或复杂病例覆盖提升的百分比。需要先完成上面的单变量配对评测，才能给出这两类效果数字。
