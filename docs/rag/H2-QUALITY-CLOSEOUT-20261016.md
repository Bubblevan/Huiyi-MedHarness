# H2-RAG-QUALITY：医学检索与回答支持最终收尾（2026-10-16）

## 1. H2 的医学检索质量有没有提升？提升多少？

**有。主结论是 RRF + BGE Reranker（D）相对 Dense 的 nDCG@10 提升。**

最终扩展 pooled-qrels 池包含 7,940 个候选，7,922 个已判定，18 个仍未决且没有默认记为不相关；覆盖率 99.773%。在 182 道候选池标签完整、所有方法 Top-10 均可评分的问题上，D 相对 Dense 的 nDCG@10 从 **0.693620 提高到 0.782991**，配对差 **+0.089371**，10,000 次 query-level bootstrap 的 95% CI 为 **[+0.064507,+0.115098]**。MRR@10 从 0.608203 提高到 0.725458，P@5 从 0.355245 提高到 0.446154，pooled Recall@10 从 0.662297 提高到 0.760749。

这也复核了先前冻结的 A–D HOLDOUT 结果：原 A–D 池上 D−Dense nDCG@10 为 +0.0915（n=181，95% CI [+0.0659,+0.1177]）。该旧分数仍保留在原文件；扩展候选池后的新分数另列，不覆盖或拼接旧分母。

这里的 Recall 只针对已判定的 pooled candidate，不是对 823,450 个语料 chunk 的全库绝对 Recall。18 个未决标签对应的问题从检索指标分母排除，未按 0 分处理。

## 2. 哪个方案最好，哪些类别改善，哪些退化？

扩展候选池的 HOLDOUT 主指标如下。每种方法均为 200 题运行；nDCG@10 的共同可评分分母为 182，P@5 和 pooled Recall 的分母为 143。

| 方法 | nDCG@10 | MRR@10 | P@5 | pooled Recall@10 |
|---|---:|---:|---:|---:|
| A · Dense | 0.6936 | 0.6082 | 0.3552 | 0.6623 |
| B · BM25 | 0.5039 | 0.5113 | 0.2629 | 0.5412 |
| C · Dense + BM25 / RRF | 0.6439 | 0.6189 | 0.3315 | 0.6769 |
| D · RRF + BGE Reranker | **0.7830** | **0.7255** | **0.4462** | **0.7607** |
| E · Dense + Iterative Retrieval | 0.7026 | 0.6044 | 0.3692 | 0.6673 |
| F · Evidence Sufficiency Policy | 0.6524 | 0.7279 | 0.4448 | **0.7716** |

**D 是全任务 pooled nDCG@10 最佳。** B 和 C 低于 Dense，说明当前 BM25 与 RRF 配置本身不能假定带来收益。D−Dense 的扩展池提升仍有正的配对区间。E 相对 Dense 仅 +0.0089，95% CI [−0.0210,+0.0386]，不能确认有排序增益。F 的 pooled Recall@10 最高，但 nDCG@10 受正确拒绝无答案问题的空结果影响，须同时读无答案和 answerable-only 分析。

分层 nDCG@10（类别分母 25–39；属于诊断性而非单类确认性结果）：

| 类别 | n | Dense | BM25 | RRF | Reranker | E | F |
|---|---:|---:|---:|---:|---:|---:|---:|
| 语义 | 29 | 0.7521 | 0.6014 | 0.7347 | **0.8307** | 0.7715 | 0.8336 |
| 精确术语 | 27 | 0.7430 | 0.6470 | 0.7170 | 0.8416 | 0.7313 | **0.8465** |
| 双语 | 26 | 0.7616 | 0.0855 | 0.4555 | **0.8119** | 0.7604 | 0.8078 |
| 多跳 | 25 | 0.8098 | 0.7005 | 0.7952 | 0.8404 | 0.8242 | **0.8457** |
| 适用范围边界 | 36 | 0.7006 | 0.6168 | 0.7267 | **0.8212** | 0.7075 | **0.8212** |
| 无答案检索 | 39 | 0.4897 | 0.3809 | 0.4779 | **0.6155** | 0.5103 | 0.0000 |

F 在无答案问题返回空结果、并正确执行拒答，所以这一类的纯排序 nDCG 为 0；它不是“误支持率”。无答案安全性单列在第 3、4 节。

在固定 120 题生成子集的 100 道可回答问题上，来源锚点严格按完整 chunk `documentId` 命中：Dense 84/120（70.0%）、D 102/120（85.0%）、E 84/120（70.0%）、F 105/120（87.5%）。多跳题两项来源锚点都命中的比例分别是 Dense 12/20（60%）、D 17/20（85%）、E 11/20（55%）、F 18/20（90%）。D 相对 Dense 的“整题全部锚点命中率”提高 16 个百分点（95% CI [+9,+24]）；E 相对 D 下降 17 个百分点（CI [−25,−9]）。F 相对 D 提高 3 个百分点（CI [0,+7]），区间触及 0；多跳完整命中提高 5 个百分点（n=20，CI [0,+15]），目前不能宣称稳健胜过 D。该指标只认精确 chunk ID，可能漏掉相邻块中的等价证据。

## 3. 自适应检索和固定多轮检索有什么差异？

E 在全任务 pooled nDCG@10 为 0.7026，低于 D 0.7830；E−D 为 **−0.080430**（n=182，95% CI [−0.113460,−0.048027]）。在 143 道可评分的 answerable 问题里，E nDCG@10 为 0.7550，较 D 低 0.0737（CI [−0.1076,−0.0399]）。E 的严格来源锚点覆盖为 70%，且多跳完整锚点命中 55%，低于 D 的 85%。本轮未针对 HOLDOUT 调参或修复 E。

F 冻结了 `h2-evidence-sufficiency-policy-v1b`，完整运行 200/200：138 次 keep、22 次补充搜索、40 次 abstain；40 道无答案题全部拒答。对 F 的空检索应用 answerable-only 口径后，143 道可评分 answerable 题的 nDCG@10 为 0.8303，D 为 0.8287；F−D 仅 **+0.0017**（95% CI [−0.0047,+0.0070]），与 D 实质持平。F 相对 E 为 +0.0753（CI [+0.0413,+0.1094]）。来源锚点上 F 为 87.5%，比 E 高 17.5 个百分点；多跳题两项锚点完整命中率比 E 高 35 个百分点（n=20，CI [+15,+55]）。因此 F 相对 E 改善了 answerable 排序与证据覆盖，但尚未显示超过 D 的稳健 answerable 排序收益。

全任务 F nDCG 较低的主要口径原因是：它在 40 道无答案 HOLDOUT 上按设计返回空结果。评估报告因此同时保留全任务主指标、answerable-only 排名、来源锚点覆盖和拒答结果，没有用单一 nDCG 替代策略目标。

## 4. 医学回答的证据支持性是否改善？

按冻结哈希从 HOLDOUT 确定性抽样，每类 20 题，共 120 个不同问题：语义、精确术语、双语、多跳、适用范围边界、无答案。无答案 20 题保留；source/version conflict 类在整个 HOLDOUT 中为 0 题。四臂使用同一个 GPT-6-Luna 生成模型与回答 Prompt，只替换检索结果；生成器看不到方法名、类别和答案性。Dense、D、E、F 各完成 120/120 生成及 120/120 工程判分，未决 0。

| 方法 | Answer Relevancy | 可判定结构化主张支持情况 | 引用 Evidence ID 有效 | 有 `sourceUri` 元数据 |
|---|---|---|---:|---:|
| Dense | 113 relevant、6 partial、1 uncertain /120 | 95/95 supported，unsupported 0 | 102/102（100%） | 26/102（25.5%） |
| D | 115 relevant、5 partial /120 | 115 supported、2 partial、2 uncertain；可判定 117/117 supported-or-partial | 130/130（100%） | 36/130（27.7%） |
| E | 115 relevant、5 partial /120 | 93 supported、1 partial、1 unsupported、3 uncertain；94/95（98.9%） supported-or-partial | 105/105（100%） | 28/105（26.7%） |
| F | 120 relevant /120 | 113/113 supported，另 1 uncertain；unsupported 0 | 121/121（100%） | 34/121（28.1%） |

配对 Answer Relevancy：D−Dense +1.67 个百分点（n=120，95% CI [−2.50,+5.83]，不确定）；F−Dense +5.83 个百分点（CI [+1.67,+10.00]）；F−D +4.17 个百分点（CI [+0.83,+8.33]）。但 claim support 的 supported-or-partial 比例 D 为 117/117，Dense 95/95，F 113/113；三者都没有观察到 unsupported claim。E 为 94/95 并出现 1 条工程判分 unsupported。差异不能解读成临床正确率变化。

在这 120 题中，四臂对 20 道无答案题均 20/20 生成了与证据不足相符的拒答。可回答题中生成器额外拒答次数为 Dense 26/100、D 7/100、E 21/100、F 6/100；这是生成层行为，不等同于检索策略本身的 false-abstain 标签。

Evidence ID 有效率是确定性检查：ID 必须属于同一答案任务的返回 EvidenceSet。`sourceUri` 只统计元数据是否存在，不代表 URL/DOI 实际可访问或已核验。

**限制：** GPT-6-Luna 既生成回答也作为回答支持 Judge，同模型自评可能偏乐观；没有独立 Judge 或外部 Gold。评估检查了结构化 claim 列表，没有穷尽拆分自由文本中的每个事实命题。因此这些数值是工程代理指标，不是 Faithfulness 临床确认，更不是医学准确率。

## 5. 代表性的质量 Bad Case 与根因是什么？

最终扩展 qrel 池导出 **17 个 answerable query 的真实配对排序退化案例**，均有完整 pooled qrels，覆盖 BM25、RRF、Reranker、E、F；每例包含原问题、来源锚点和必要证据原文、候选证据判分、六臂 Top-5 与比较指标。判因仍是工程假设，未做针对性修复实验。

- **双语词法失配（H2-H-076）：** BM25 nDCG@10 为 0，Dense 为 1.0；BM25 前列命中无关慧宜网页块，Dense 在首位找到 StatPearls 来源锚点。假设是中文查询与英文证据的词面鸿沟使 FTS/BM25 词项重叠失效。该假设未通过单变量实验验证。
- **迭代规划损失精确实体（H2-H-032）：** “water deprivation test”问题上 E nDCG@10 为 0.1906，D 为 0.9743；D 首位命中 Harrison 相关块，E 的 Top-5 没有直接支持等级候选。可能原因是查询改写/融合压低精确术语证据，尚未隔离到某一步。
- **Reranker 多跳重排退化（H2-H-119）：** RRF Top-3 含两个直接支持所需证据的块；Reranker 把它们移出 Top-5，nDCG@10 从 1.0 降为 0.7725。可能是 cross-encoder 对局部主题相关段落赋权高于两项证据要素的完整覆盖。
- **F 双语边界退化（H2-H-067）：** F 相对 D nDCG@10 低 0.0569；完整来源锚点未命中。该案例显示当前 sufficiency decision 没有保证修复跨语言召回，不可因总体锚点覆盖较高而隐藏个例。
- **池内没有直接支持候选（H2-H-087）：** 参考来源锚点是 PubMed 块，但多方法候选池没有 grade-2 直接支持候选；BM25 仅返回无关网页块，Dense 也只有上下文级候选。该例将问题指向候选生成/池召回边界，而不能归因于排序器单独失误。

完整 17 例与每条 Top-5/qrel/证据引用见 [扩展 Bad Cases JSON](H2-QUALITY-EXTENDED-BAD-CASES-20261016.json)。案例中的根因文字均标为未验证假设；本轮没有声称已修复。

## 6. LLM Judge 与外部 Gold 的一致性如何？

**未知，未计算。** 没有可用的外部专家/临床 Gold 子集，不能报告一致率、Kappa 或医生审核结果。HOLDOUT query-document 候选对方法名、排名和分数盲化，由 GPT-6-Luna 依据固定 0/1/2 规则判分；低置信自动复核栏为 0，但 18 个无法解析/未决标签仍保留未决，没有强行赋级。最终候选覆盖率 99.773%。

答案支持部分同样是 GPT-6-Luna 工程 Judge，且与生成器为同一模型。所有这些标签均非人工临床审核。

## 7. 当前无法证明什么？

- 不能证明不同指南版本、来源之间的冲突处理能力：该 HOLDOUT 的 source/version conflict 题数为 **0**。
- 不能证明外部 Gold 一致性、医生接受度、临床安全、医学诊断准确性或真实患者获益。
- 不能把 pooled Recall 说成对 823,450 chunks 的全库 Recall，也不能把 `sourceUri` 字段存在说成外链可访问。
- 不能保证自由回答里每个事实子句都已完整拆分并逐句核验。
- F 相对 D 的 anchor 增益区间触及 0；F 对 D 的 answerable-only nDCG 没有可区分提升。

因此状态为：`QUALITY_IMPROVEMENT_DEMONSTRATED=YES`（D 相对 Dense 的冻结 HOLDOUT nDCG 配对区间为正，且完成回答支持性分析）；`QUALITY_EVALUATION_COMPLETE=NO`（source-conflict 类别缺失，且没有外部 Gold/临床验证）。H2 的主要检索闭环已交付，但 TRD 的完整定义仍未全部满足。

## 8. 耗时、Token、资源与部署成本

本轮复用了五源本地语料与活动 Qwen3-Embedding-0.6B/FAISS 索引：823,450 chunks，未下载语料、未重建索引、未改变患者 Memory/RAG 隔离。Reranker 为本机 `bge-reranker-v2-m3`；规划与工程 Judge 经 GPT-6-Luna Codex CLI。没有公网部署或服务并发压测。

| 运行 | 成功/规模 | P50 / P95 | Planner/评审 token |
|---|---:|---:|---:|
| D · RRF + Reranker（冻结 A–D） | 200/200 | 1.705s / 2.870s | 不含一次性加载 |
| E · 最终迭代检索 | 200/200；160 条原查询复用、40 条变更查询重跑 | 21.933s / 26.475s | 390,137 planner tokens；40 个批次，最多观测批次延迟 11.354s |
| F · 自适应充分性策略 | 200/200；138 keep、22 search、40 abstain | 12.313s / 13.843s | 296,799 planner tokens；20 个批次 |
| D/E/F 答案生成 + Judge | 360/360 + 360/360 | 批次共用延迟，不伪造单题延迟 | 699,751 + 463,773 tokens |
| Dense 答案生成 + Judge | 120/120 + 120/120 | 批次共用延迟 | 235,428 + 91,013 tokens |
| 候选池 LLM 判分 | A–D 6,991 候选；E2 198；F 18 | — | 2,700,565 + 193,505 + 47,126 tokens |

E 的 160 条复用仅限最终数据 SHA 下 query 文本完全未变的问题；40 条被 no-answer 文本修订的问题已按最终 HOLDOUT 重跑。此前绑定旧 query SHA 的 E HOLDOUT 运行没有用于最终指标。

为降低上下文成本，最终回答支持包采用 Top-5、每段最多 800 字符。最初较大的 Top-10/2,000 字符生成试跑只完成 30 个答案后停止，消耗 136,730 tokens；该试跑不进入任何指标。最终机器工件、SHA-256、代码脚本哈希与参数见 [最终运行清单](H2-QUALITY-FINAL-RUN-MANIFEST-20261016.json)。

### 可复核机器结果

- [扩展 A–F HOLDOUT 完整逐题评分](H2-QUALITY-EXTENDED-HOLDOUT-SCORE-20261016.json)
- [Dense/D/E/F 配对评分与 95% CI](H2-QUALITY-HOLDOUT-PAIRED-DEF-20261016.json)
- [Dense/D/E/F 回答支持与配对评分](H2-QUALITY-ANSWER-SUPPORT-PAIRED-20261016.json)
- [来源锚点覆盖及配对 CI](H2-QUALITY-SOURCE-ANCHOR-COVERAGE-20261016.json)
- [answerable-only 排序与配对 CI](H2-QUALITY-ANSWERABLE-SUBSET-20261016.json)
- [17 个扩展 HOLDOUT Bad Cases](H2-QUALITY-EXTENDED-BAD-CASES-20261016.json)
- [冻结 A–D 原始 HOLDOUT 结果](H2-QUALITY-HOLDOUT-SCORE-20261016.json)
- [DEV 结果](H2-QUALITY-DEV-RESULTS-20261016.md)
