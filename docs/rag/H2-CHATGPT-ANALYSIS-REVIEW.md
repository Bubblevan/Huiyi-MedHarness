# H2 医学 RAG 分析审阅与面试口径

审阅日期：2026-10-15
检索运行基线：`28ba197ed3499272efdfaeda20645be7300ec796`；当前 H2 评分器/报告分支 HEAD：`1913e040f970780383ae11cc9eae74b3599e9c0e`
核对材料：用户粘贴的 ChatGPT 分析、H2 审计/运行工件、i-MedRAG 原论文与 Qwen3-Embedding 官方模型卡。

## 结论

这份分析适合作为技术学习和面试攻防提纲。它对“检索相关性、来源可信与适用性、引用定位、主张支持度”分层的建议是正确方向；但原文把项目事实、旧实验、论文结果和未来建议放在同一篇长文里，使用时必须给每项加上时间与证据边界。

当前 H2 已经有首轮检索质量指标：12 个 DEV 问题中，严格完整 qrels 允许 9 个进入 nDCG/MRR 评分，直接支持 Precision/Recall 的分母为 6。标签由 GPT-6-Luna 生成和复核，不是医生或外部 Gold。英文化查询 BM25 在这 9 题上的 nDCG@10 比原 BM25 高 0.3135（配对 bootstrap 95% CI +0.1636 至 +0.4624）；这是待复验的小样本信号，不是临床准确率或生产胜出结论。Dense、BM25、RRF、BGE Cross-Encoder 和 Iterative 已有严格口径下的检索指标，检索质量现已可讨论，但仍未满足 300 题 / HOLDOUT、答案支持评测和外部 Gold 一致性要求。

## 逐项事实核对

| ChatGPT 分析中的说法 | 核对结论 | 可安全使用的说法 |
|---|---|---|
| 五源索引约 82.35 万段 | 已由活动 manifest 核实：823,450 chunks；PubMed 与 Wikipedia 是本地部分快照，慧宜来源为官网公开资料，不是 EMR。 | “五源索引包含 823,450 个片段；该数字不是文献数、患者数或全量 PubMed/Wikipedia。” |
| 产品检索是 Qwen3 Dense + FAISS，可选迭代；没有 BM25/RRF/Reranker | 对产品在线路径成立。当前 BM25、RRF、BGE reranker 仅在 H2 离线候选池/评测脚本中运行，没有接入 Health Engine。 | 明确区分“产品路径”和“离线消融路径”。 |
| DSH 是外层 AgentLoop，Health Engine 返回 EvidenceSet | 与仓库边界一致。Health Engine 的 Planner 规划检索问题，不负责生成最终用户答案；Encounter/Memory 与外部证据分离。 | 可作为架构主线讲述。 |
| i-MedRAG 的多轮追问提供复杂问题检索思路 | 原论文描述：后续查询由先前信息搜寻尝试引导，查询由传统 RAG 回答，其结果再引导后续查询。慧宜采用受限的 evidence-acquisition 变体，不是论文完整复现。 | “借鉴 i-MedRAG 的迭代查询思想；Health Engine 只取证据，最终回答仍由 DSH 生成。” |
| 1/10→10/10、29/29 可追溯等旧数字 | 仓库审计找到 10 个旧开发任务及其历史评分工件；口径是小样本工程任务规则满足度/ID 可解析性，不是检索 qrels、医学正确率或临床审核。 | 如要讲，只能标为历史开发集工程结果，并给出其旧代码 SHA 与评分协议；不要用作 H2 A–E 质量结论。 |
| 45 题 MedQA 的 A/B/C 准确率 | 属于单独的 HC-RAG-002 QA parity 实验，使用 MedCPT 语料/配置和生成问答链路，不是当前 Qwen3 五源索引的检索质量评测。三臂也不是纯粹的 No-RAG vs RAG 对照。 | 可用于解释历史 parity 与 Agent 执行问题，不能并入 H2 的 Recall/MRR/nDCG。 |
| MedCPT 中文 tokenizer 问题证明迁移 Qwen3 更好 | 历史问题可作迁移动机；当前 12 题 Pilot 已有机器判定 qrels，但不是人工或外部 Gold。 | “为多语言场景更换编码器并保留 MedCPT 独立索引”；整体优劣以严格 qrel Pilot 描述，并注明 n=9 与同模型偏差。 |
| 120 条问题、六类各 20 条 | 这是早期 ChatGPT 建议，已被 H2-RAG-QUALITY 的 300 题目标替代；当前仍只有 12 题质量 Pilot。 | 现阶段报告 12 题 DEV 探索结果，不得说已完成 300 题或 HOLDOUT。 |
| 11 日单查询约 9.2 秒、PlannerError 案例 | 属于旧的一次性诊断/历史运行。当前 10 月 15 日 E* 有 12 个问题的独立运行与更完整成本记录；旧事件根因未被唯一确认。 | 每项都注明 run ID、日期和运行边界；不要把旧单次探针与新 Pilot 合并。 |
| 所有 A–E 消融都可直接比较 | 有两项口径需修正：D 存档的 `latencyMs` 是 reranker 阶段值，未含 RRF 检索；E* 是 Dense+Planner 成本探针，还不是“最优已验证配置 + Planner”。 | 使用下方修订的 D 暖态分段求和延迟；E* 只讲执行成本与额外调用，不讲质量优劣。 |

## 当前实际测量到什么

### 检索质量（先看质量，再看成本）

12 题草案中，严格 qrel 完整后 nDCG@10 / MRR@10 的共同分母是 9；grade-2 直接支持 Precision@5 / pooled Recall@5 的共同分母是 6。数字是 GPT-6-Luna 机器相关性判断，不是医生审核、外部 Gold 或最终答案正确率。

| 配置 | nDCG@10 (n=9) | MRR@10 (n=9) | Precision@5 (n=6) | Pooled Recall@5 (n=6) |
|---|---:|---:|---:|---:|
| Dense | 0.6130 | 0.2722 | 0.2667 | 0.2583 |
| BM25 | 0.1694 | 0.0833 | 0.0667 | 0.1111 |
| RRF | 0.3826 | 0.2214 | 0.1667 | 0.1542 |
| RRF + BGE reranker | 0.6062 | **0.3704** | **0.4000** | **0.4014** |
| Dense + iterative GPT-6-Luna | **0.6748** | 0.3333 | 0.3000 | 0.2417 |
| BM25 + English lexical query translation | 0.4829 | 0.2917 | 0.1333 | 0.1875 |

迭代臂的 nDCG 点估计高于 Dense 0.0618，但配对 95% CI 为 −0.0146 至 +0.1428，跨过 0；重排器 nDCG 与 Dense 接近。English translation 与原 BM25 的 nDCG 配对差为 +0.3135（CI +0.1636 至 +0.4624），但只有 9 题，且 GPT-6-Luna 同时生成译文和 qrels。这些是探索性检索排序指标；答案支持、错误支持率和临床准确率仍未测量。

### 执行成本

A–D 在同一批 12 个 DEV 草案问题上各运行 12/12 成功，每臂候选数为 20。以下是单次运行观察，不能替代稳定负载基准：

| 配置 | P50 / P95 | 解释 |
|---|---:|---|
| Dense | 275.0 / 672.4 ms | 当前检索基线 |
| BM25 | 3.2 / 3,869.7 ms | 两个双语问题匹配 778k/803k 个 chunk，造成尾延迟 |
| Dense + BM25 / RRF | 277.4 / 4,194.4 ms | RRF 耗时由两路检索相加；融合本身开销可忽略 |
| RRF + BGE reranker | reranker 阶段 114.0 / 255.3 ms；暖态 RRF+reranker 分段求和 396.6 / 4,285.9 ms | 分段求和按同一 question ID 合并旧 `run-rrf.json` 与 reranker 阶段记录；不是一次端到端 D 测量。reranker 加载+12题重排合计 4,881.7 ms，另作运行级开销记录。 |
| Dense + Iterative GPT-6-Luna（E*） | 9,408.7 / 12,350.2 ms | 每题两轮、两次 Planner 与两次检索；24 次 Planner 总计 415,247 输入 / 975 输出 Token。 |

延迟与执行成功率和检索质量是不同指标。当前 qrel 合并池有 626 个候选、621 个已解决标签（99.2%）；严格计分要求一题的完整 pooled qrels 均已解决，因此 3 题整体排除，不能将未决标签当作 grade 0。候选相关性 Bad Case 有 15 条方法-问题观察，其中 11 条被计为机器判定的检索质量退化；它们不是 15 个独立病例，也不是人工临床审核。完整口径和逐题结果见 [H2 Pilot 质量报告](H2-PILOT-QUALITY-SCORE-20261015.md) 与 [Bad Case 清单](H2-PILOT-BAD-CASES-20261015.md)。

## 外部论文与模型资料的正确用法

- [i-MedRAG 原论文](https://arxiv.org/abs/2408.00727)支持“根据前序信息搜寻结果生成 follow-up queries”的研究背景，但其任务、生成器与实验数据不等于慧宜的实现或评测结果。
- [Qwen3-Embedding-0.6B 官方模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)记录了多语言能力、query instruction、last-token pooling 与 L2 normalization 的示例。这些说明模型使用方法，不证明本地医疗语料上的检索质量。
- [MedRAG/i-MedRAG 官方仓库](https://github.com/gzxiong/MedRAG)可用于核对上游用法，不代表慧宜复制了整个上游系统。

## 修订后的面试口径

**30 秒版本：**

> 我负责医学外部证据检索这一层。当前在线 Health Engine 用 Qwen3-Embedding-0.6B 与按来源组织的 FAISS 索引，五源快照共 823,450 个文本片段；复杂查询可以使用有界 Planner 补充检索，最后输出带文档、chunk 和 evidence ID 的 EvidenceSet，由 DSH 负责最终回答。患者 Encounter/Memory 与公共医学证据分开管理。我们已经离线运行 Dense、BM25、RRF、BGE 重排和迭代检索的成本试验；检索质量 Pilot 正在等待独立相关性标注，所以目前我只报告运行与延迟，不声称质量提升。

**2 分钟版本：**

> 离线侧先把教材、StatPearls、本地 PubMed/Wikipedia 分片和慧宜医院公开网页整理成可核验的 corpus manifest；每条来源索引绑定自己的 metadata、内容哈希和同一套 Qwen3-Embedding-0.6B 编码版本。MedCPT 的旧索引单独保留，避免跨 Encoder 混搜。
>
> 在线侧由 DSH 接收用户请求并调用 `search_medical_evidence`。Health Engine 校验 query 与模式后，在五个来源的 FAISS 索引中做 Dense 召回。复杂查询可通过有界 Planner 提出补充检索问题；Health Engine 去重、合并命中并按证据预算输出带 evidence ID、document/chunk 定位的 EvidenceSet，最终答案仍由 DSH 生成。患者 Encounter 和 AMA Memory 沿独立上下文链路流转。
>
> 我们已在五源固定快照上比较 Dense、BM25、RRF、BGE 重排与迭代检索。当前 12 题严格评分的 nDCG@10 分母是 9；迭代臂点估计 0.6748、Dense 0.6130，但配对区间跨过 0。BM25 英文化查询相对原 BM25 提高 0.3135（同模型评审、n=9），需要更大 DEV 与冻结 HOLDOUT 复验。现在能报告探索性检索排序质量，不能把它说成临床答案准确率或生产效果。

**被追问“BM25/RRF/Reranker 是否上线”时：**

> 目前没有接入产品在线 Health Engine。它们是同一固定语料上的离线消融臂。12 题 Pilot 已有机器判定的 nDCG/MRR 与 grade-2 Precision/Recall；该结果样本小、没有外部 Gold，对上线决策不够。除延迟成本外，还必须完成更大规模 DEV/HOLDOUT 和答案支持性评测。

**被追问“RAG 提高准确率多少”时：**

> 当前只有探索性检索排序数字：9 个可评分 DEV 问题上，Dense nDCG@10 为 0.6130，迭代检索为 0.6748，差值 +0.0618 的配对区间跨过 0；英文化查询 BM25 相对原 BM25 差值 +0.3135。它们是 LLM-as-Judge 的检索指标，不是最终医学答案准确率。旧的 10 题开发规则满足度与 45 题 MedQA parity 属于不同实验，不能拼入本轮。

## 尚未达到的交付条件

1. 完成至少 300 道质量检查问题，固定 100 DEV / 200 HOLDOUT；外部 BioASQ 下载目前需注册，本机无数据，source-grounded LLM 合成题必须独立标记。
2. 在完整、严格 qrel 上运行 A–E，并实现和比较自适应证据充分性检索 F；目前只完成 12 题 A–E/翻译诊断，F 未完成。
3. 对至少 100 道题使用固定生成模型做答案支持、必要证据覆盖、引用有效性和无依据医学主张率评测；目前尚未完成。
4. 形成至少 15 个真实质量失败分析（至少 10 个检索/证据质量失败）。当前 15 条是方法-问题观察，不等于 15 个独立失败案例，不能视为满足门槛。
5. 将 GPT-6-Luna qrels 与外部 Gold 子集比较；目前外部 Gold 一致性未测。

在这些条件完成前，最强而准确的 H2 结论是：**五源索引和可追溯 EvidenceSet 链路已具备；首轮 12 题已产出可复现的探索性检索质量指标，并出现英文化查询 BM25 的正向小样本信号；300 题/HOLDOUT、自适应 F、答案支持与外部 Gold 验证仍未完成。**
