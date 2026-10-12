# B3｜患者纵向记忆与复杂病例协作：首轮证据冻结

## 决定

**状态：`ENGINEERING_SIGNAL_OBSERVED / MEMORY_ATTRIBUTION_INSUFFICIENT_EVIDENCE`。** 现有 GPT-6-Luna 配对运行显示 Integrated 对已披露历史事实的正确引用高于 Single；AMA trace 也记录到自动召回和记忆提交。最终样本为 5 个完整配对病例、40 个配对任务；trace 不含可把回答事实逐条映射到 AMA 返回记忆项的来源 ID，不能把引用分数归因于 AMA 长期记忆。复杂病例关键分析点覆盖率没有冻结评分结果。

## 同版本配对评分

- **运行：** `20261011184053-5bce7818`，源码 `0c7ddc93df99cbe92cc4ac4b25ba34c933e376b0`，固定 cohort，GPT-6-Luna。
- **样本：** 40 个可配对任务、5 个完整配对病例；最终 80 条 arm-turn 记录全部完成。早期重试中的 21 条失败仍保留在 `attempt-history.jsonl`；最终任务状态和失败尝试分别统计。
- **已披露历史事实正确引用：** Single 21/40（52.5%）；Integrated 36/40（90.0%），净差 **+37.5 个百分点**。逐事实配对结果为 Integrated-only 15、Single-only 0、双方同分 25。
- **口径限制：** 盲化模型辅助工程评分检查回答是否正确引用了模拟患者实际披露的事实，隐藏事实不计为必答。它不是医生审核，也没有证明 Integrated 的事实来自 AMA 跨就诊召回，而非会话文本、当前请求或其他上下文。

## AMA 与协作运行元数据

当前 run 的 `memory-trace.jsonl` 有 167 条结构化事件：

| 操作 | 完成 | 失败 | 跳过 | 说明 |
|---|---:|---:|---:|---|
| automatic_recall | 13 | 1 | 59 | trace 只存元数据和 item 数，不存记忆正文/事实来源 ID |
| commit | 19 | 3 | 61 | 不能把跳过算作失败 |
| session_end | 9 | 0 | 2 | 生命周期清理元数据 |

同一运行的工具计数器记录 `consult_clinical_team` 5 次 completed、`search_medical_evidence` 5 次 completed。这证明这些工具路径在部分 turn 中确实运行，不表示专家结论质量、复杂病例分析点覆盖或协作成功率。

## 当前可写与不可写

可报告同一冻结 run 上的“已披露历史事实正确引用率”配对差；不可把它写成 AMA 召回准确率、跨就诊病史正确召回率或临床收益。当前没有来源级 memory ID 与回答事实的配对映射，也没有复杂病例关键点覆盖评分。样本只有 5 个完整开发病例；早期 21 次失败尝试保留在历史中，最终 80 条任务臂记录均完成。数字仅是工程信号，不能外推至 300 例或线上患者。

**简历候选（仅工程信号）：**

> 在 GPT-6-Luna 驱动的 5 个合成纵向病例、40 条配对已披露历史事实工程评测中，Integrated 正确引用 36/40（90.0%），Single 为 21/40（52.5%），配对差 +37.5 个百分点；AMA trace 记录自动召回 13/14 次完成、记忆提交 19/22 次完成。现有数据尚不能将正确引用归因于 AMA 跨就诊记忆，复杂病例关键点覆盖率未测。

**阶段结论：`INSUFFICIENT_EVIDENCE` 用于“AMA 记忆正确召回 / 多专家复杂病例覆盖提升”效果主张。** 不新增模型调用或病例；待要进行 Bullet 3 的定向实验时，最小缺口是把检索到的 memory item 稳定 ID 与已披露事实/回答引用做脱敏逐条映射，并冻结复杂病例评分分母。

## 可复核来源

- [B1 配对逐题评分与分母](B1-SPRINT-002-RESULTS.md)
- [机器可读评分及历史事实判定](B1-SPRINT-002-RESULTS.json)
- [当前 run 的结构化 memory/tool trace](../../artifacts/clinical-eval/runs/20261011184053-5bce7818/memory-trace.jsonl)
- [当前 run manifest](../../artifacts/clinical-eval/runs/20261011184053-5bce7818/manifest.json)
