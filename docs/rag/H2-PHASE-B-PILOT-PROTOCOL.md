# H2 Phase B：检索标注 Pilot 协议

状态：现有 12 题 DEV 试标及 A–E 候选池已冻结；LLM Judge/评分代码已实现。当前 GPT-6-Luna loopback 返回 HTTP 401，已用当前 Codex 对 H2-P-001 做一题模型 fallback smoke；完整检索质量结论尚未成立。  
范围：评检索、证据覆盖及后续回答支持性，不接触患者 Memory。最终 H2 评测要求 100 DEV + 200 HOLDOUT；本 12 题只用于试标和诊断。

## 数据集构成

首批 DEV Pilot 固定 12 个独立问题，六类各 2 个：

1. 精确术语
2. 普通语义查询
3. 多跳证据
4. 中英双语
5. 来源冲突
6. 无答案/当前语料未覆盖

现有 B2 的 10 个 T07 合成任务保留为候选问题来源/历史结果，但不直接作为该 Pilot 的完整问题集：它们主要询问临床工作流流程，未覆盖上述六类，也没有相关文档金标。不得从单一 Dense 结果反推 qrels。Pilot 问题由评测维护者先冻结；每个问题先构造 Dense 与 BM25 的 pooled candidate set，再隐藏检索方法、排序和分数供审核。

## LLM Judge 标注单位与口径

- 主 Judge 等级固定为 0/1/2：0 无关或不可用；1 相关背景/仅支持部分方面；2 直接支持问题的重要信息或必要证据要素。nDCG 使用 `2^grade-1`；主 Precision/Recall/MRR 以 grade 2 为直接支持阈值，同时单列包含 grade 1 的 context 指标。
- Judge 必须返回 `answer_support`、原文精确 `evidence_quote`、`conflict_type`、理由和置信度。非零等级的 quote 必须逐字出现在候选片段；不确定、低置信、解析失败、缺项或服务失败不得默认标为 0。
- 每批 Judge 输入只含 query、候选 ID、来源集合、标题和片段；不含方法、排名、原始分数、任务类别或原题 ID。每个批次保存 prompt/schema 版本、模型标识、输入哈希和原始输出。
- 低置信、`uncertain`、模型分歧进入复核队列；可用独立模型时优先复核。外部专家 Gold 子集的一致性单独报告；机器标签不称为临床审核。当前没有可验证的外部 Gold agreement。
- “无答案”代表冻结语料和候选覆盖范围内没有可用支持，不代表医学上不存在答案。source-anchored no-answer 题须保留证据范围依据，未能检查的保持 uncertain。
- Recall@K 是 pooled qrels 上的 Recall，非全语料穷举召回。DEV 用于方法选择，200 条 HOLDOUT 在方法、Judge prompt、证据充分策略冻结前不得用于调参。

Legacy note: `score.py` 与 0–3 人工审核表继续支持既有独立审核格式；它们不是当前自动 Judge 的标签定义，也不构成临床专家 Gold。不得将两种尺度直接混算。

## 方法比较冻结口径

- A Dense：当前 Qwen3-Embedding-0.6B / FAISS。
- B BM25：同一 corpus chunk 与 source ID，确定并冻结中英 tokenizer、字段权重、k1/b 参数。
- C Dense+BM25/RRF：两路各取固定候选预算；RRF 分数、常数、去重 ID、并列排序规则预先固定；融合结果截到共同候选预算。
- D C + cross-encoder：只重排 C 的同一候选池，不增加候选数；模型仅从现有本机 `bge-reranker-v2-m3` 加载。
- E 最优的、已在 DEV 验证配置 + Iterative Planner：设定全 query 最大候选池预算与最大 planner 调用数；单独报告 planner 调用、planner token、检索延迟、总延迟。候选不得因迭代而超过其他臂的最终候选预算。

在 qrels 完成并选出 DEV 最优配置之前，Dense + Planner 运行只能标记为成本/可行性探针，不称作上述 E 消融臂。各阶段需分别记录：检索延迟、重排延迟、Planner 延迟、模型冷启动/加载时间，以及可比较的暖态端到端延迟；用于 A/B 表格的 `latencyMs` 必须表示同一边界的完整请求耗时。

建议主配置统一为 `candidateBudget=50`、返回展示 `K=10`；Pilot 先用更小池以控制双人标注工作量。各方法需要报告算法配置、模型 revision、corpus/manifest hash、代码 SHA、输入 query hash、候选预算与运行参数。迭代臂产生更多 planner 调用不被解释成免费或更公平的提升。

## 当前执行状态与下一步

`judge_pool.py` 校验结构、候选覆盖和逐字 evidence quote，记录原始模型输出、置信度与失败类型；`score_judge_runs.py` 输出分级 nDCG、直接支持和上下文 Precision/Recall/MRR、按类别聚合、配对差值及确定种子的 Bootstrap 区间。缺失结果不当成 0 分。

本机 8333 GPT-6-Luna route 对 placeholder Bearer 返回 HTTP 401；没有配置的用户级 Judge 凭据。备用当前 Codex 会话模型已对 H2-P-001 的 38 个盲化候选作一次性 smoke，36/38 标签高于复核阈值，2/38 待复核；因此解析结果只作为一个问题的探索性诊断，不解锁 A–E 方法优劣结论。BioASQ 文件不在已检查的本机语料目录；用户本地 V4 90-task 夹具评测患者工作流，不替代来源锚定的 RAG qrels。

接下来以 100 DEV / 200 HOLDOUT 为目标，优先查找许可兼容的 BioASQ 参考题并验证其 Gold 文献能否映射到固定五源索引；覆盖不足时从本地五源内容生成可追溯且经质量筛选的问题。既不要求用户手填 Excel，也不改 active FAISS 索引或下载/重建大语料。自动 Judge 路由可用后先完成所有 DEV 候选池评分、低置信复核和 Judge/外部 Gold 一致性；再锁定 A–E 及自适应 F、跑至少 100 题回答支持性评测，最终输出真实质量 Bad Cases。
