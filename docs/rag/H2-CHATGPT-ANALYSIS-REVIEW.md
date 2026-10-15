# H2 医学 RAG 分析审阅与面试口径

审阅日期：2026-10-15  
代码基线：当前 checkout `28ba197ed3499272efdfaeda20645be7300ec796`  
核对材料：用户粘贴的 ChatGPT 分析、H2 审计/运行工件、i-MedRAG 原论文与 Qwen3-Embedding 官方模型卡。

## 结论

这份分析适合作为技术学习和面试攻防提纲。它对“检索相关性、来源可信与适用性、引用定位、主张支持度”分层的建议是正确方向；但原文把项目事实、旧实验、论文结果和未来建议放在同一篇长文里，使用时必须给每项加上时间与证据边界。

当前 H2 已经多走了一步：BM25、RRF、BGE Cross-Encoder 和 Dense+Iterative Planner 都在离线评测路径上有运行记录。但质量 qrels 还没有审核完成，因此不能说其中任何一种检索方法提高了医学证据质量，也不能把运行成功或引用 ID 可解析率当作临床准确率。

## 逐项事实核对

| ChatGPT 分析中的说法 | 核对结论 | 可安全使用的说法 |
|---|---|---|
| 五源索引约 82.35 万段 | 已由活动 manifest 核实：823,450 chunks；PubMed 与 Wikipedia 是本地部分快照，慧宜来源为官网公开资料，不是 EMR。 | “五源索引包含 823,450 个片段；该数字不是文献数、患者数或全量 PubMed/Wikipedia。” |
| 产品检索是 Qwen3 Dense + FAISS，可选迭代；没有 BM25/RRF/Reranker | 对产品在线路径成立。当前 BM25、RRF、BGE reranker 仅在 H2 离线候选池/评测脚本中运行，没有接入 Health Engine。 | 明确区分“产品路径”和“离线消融路径”。 |
| DSH 是外层 AgentLoop，Health Engine 返回 EvidenceSet | 与仓库边界一致。Health Engine 的 Planner 规划检索问题，不负责生成最终用户答案；Encounter/Memory 与外部证据分离。 | 可作为架构主线讲述。 |
| i-MedRAG 的多轮追问提供复杂问题检索思路 | 原论文描述：后续查询由先前信息搜寻尝试引导，查询由传统 RAG 回答，其结果再引导后续查询。慧宜采用受限的 evidence-acquisition 变体，不是论文完整复现。 | “借鉴 i-MedRAG 的迭代查询思想；Health Engine 只取证据，最终回答仍由 DSH 生成。” |
| 1/10→10/10、29/29 可追溯等旧数字 | 仓库审计找到 10 个旧开发任务及其历史评分工件；口径是小样本工程任务规则满足度/ID 可解析性，不是检索 qrels、医学正确率或临床审核。 | 如要讲，只能标为历史开发集工程结果，并给出其旧代码 SHA 与评分协议；不要用作 H2 A–E 质量结论。 |
| 45 题 MedQA 的 A/B/C 准确率 | 属于单独的 HC-RAG-002 QA parity 实验，使用 MedCPT 语料/配置和生成问答链路，不是当前 Qwen3 五源索引的检索质量评测。三臂也不是纯粹的 No-RAG vs RAG 对照。 | 可用于解释历史 parity 与 Agent 执行问题，不能并入 H2 的 Recall/MRR/nDCG。 |
| MedCPT 中文 tokenizer 问题证明迁移 Qwen3 更好 | 历史检索问题可作为迁移动机，但它本身不能证明 Qwen3 对当前全部问题更优。当前 A–E 还没有人工 qrels。 | 说“为多语言场景更换了编码器，并保留 MedCPT 独立索引”；总体优劣要由同一标注集评测。 |
| 120 条问题、六类各 20 条 | 这是 ChatGPT 提出的未来 DEV 规模建议，不是现有冻结数据。当前 Pilot 只有 12 条待审核草案。 | 不得说已完成 120 题基准或 HOLDOUT。 |
| 11 日单查询约 9.2 秒、PlannerError 案例 | 属于旧的一次性诊断/历史运行。当前 10 月 15 日 E* 有 12 个问题的独立运行与更完整成本记录；旧事件根因未被唯一确认。 | 每项都注明 run ID、日期和运行边界；不要把旧单次探针与新 Pilot 合并。 |
| 所有 A–E 消融都可直接比较 | 有两项口径需修正：D 存档的 `latencyMs` 是 reranker 阶段值，未含 RRF 检索；E* 是 Dense+Planner 成本探针，还不是“最优已验证配置 + Planner”。 | 使用下方修订的 D 暖态分段求和延迟；E* 只讲执行成本与额外调用，不讲质量优劣。 |

## 当前实际测量到什么

A–D 在同一批 12 个 DEV 草案问题上各运行 12/12 成功，每臂候选数为 20。以下是单次运行观察，不能替代稳定负载基准：

| 配置 | P50 / P95 | 解释 |
|---|---:|---|
| Dense | 275.0 / 672.4 ms | 当前检索基线 |
| BM25 | 3.2 / 3,869.7 ms | 两个双语问题匹配 778k/803k 个 chunk，造成尾延迟 |
| Dense + BM25 / RRF | 277.4 / 4,194.4 ms | RRF 耗时由两路检索相加；融合本身开销可忽略 |
| RRF + BGE reranker | reranker 阶段 114.0 / 255.3 ms；暖态 RRF+reranker 分段求和 396.6 / 4,285.9 ms | 分段求和按同一 question ID 合并旧 `run-rrf.json` 与 reranker 阶段记录；不是一次端到端 D 测量。reranker 加载+12题重排合计 4,881.7 ms，另作运行级开销记录。 |
| Dense + Iterative GPT-6-Luna（E*） | 9,408.7 / 12,350.2 ms | 每题两轮、两次 Planner 与两次检索；24 次 Planner 总计 415,247 输入 / 975 输出 Token。 |

这些数值是执行率、延迟、调用和 Token 成本。由于 12 题仍无双人 qrels，Recall@K、MRR、nDCG、适用性与引用支持率均未评分。10 个检索相关性 Bad Case 也不能从运行耗时或检索文本中直接宣称已完成人工判定。

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
> 我们正在用固定 DEV 问题做旁路消融。首轮 12 题运行中，Dense、BM25、RRF、Reranker 和 Iterative 都跑通，但质量金标仍在盲审，所以没有 Recall/MRR/nDCG 增益结论。成本上已看到 BM25 双语长尾以及迭代 Planner 的高输入 Token 与多秒延迟。下一步以人工 qrels 比较证据相关性，再决定哪些组件值得进入产品路径。

**被追问“BM25/RRF/Reranker 是否上线”时：**

> 目前没有接入产品在线 Health Engine。我们把它们作为同一语料、同一候选预算下的离线消融臂。候选相关性还没评分，是否上线取决于 qrels 质量结果与延迟成本；当前能确认的是 BM25 双语查询尾延迟较高，BGE 阶段耗时另行记录，迭代 Planner 输入 Token 成本明显。

**被追问“RAG 提高准确率多少”时：**

> 目前没有同一固定 qrels 下的检索质量提升数字。旧的 10 题开发任务规则满足度和 45 题 MedQA parity 属于不同实验口径，不与这次五源 Qwen 检索 Pilot 合并。现在这轮的质量指标仍待盲审与裁决。

## 尚未达到的交付条件

1. 两份 v2 盲审表由两位评审独立完成，并裁决分歧；再计算 pooled Recall@K、MRR、nDCG、适用性和方法差值。
2. 使用最终 qrels 从 A–D 选择 DEV 最优配置，重新执行符合固定总候选预算的 E 臂；E* 旧运行只保留为成本探针。
3. 从已标注结果中抽取并分析至少 10 个相关性/覆盖 Bad Case。
4. 另冻结回答子集及 claim–evidence 关联数据，才可评估 Citation ID、来源定位和医学主张支持率。

在这些条件完成前，最强而准确的 H2 结论是：**五源索引和可追溯 EvidenceSet 链路已具备；五种候选方法的运行成本已有首轮观测；检索质量差异和医学引用支持率仍未测得。**
