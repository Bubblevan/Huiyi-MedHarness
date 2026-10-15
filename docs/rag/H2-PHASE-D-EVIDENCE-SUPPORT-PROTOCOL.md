# H2 Phase D：Evidence ID 与医学主张支持度评测协议

状态：协议已定义；本轮没有生成最终回答，也没有 claim-support 分数。

## 目的与边界

检索相关性和回答中的医学证据支持是不同问题。Recall@K/MRR/nDCG 只回答相关片段是否进入排序结果；它们不证明模型引用了正确片段，也不证明片段支持最终回答。

Health Engine 的 EvidenceSet 已包含可识别的 MED evidenceId，以及 source、sourceDocumentId 和 chunkId。一次 H2-P-001 服务 Trace 中，3 条返回证据均有可解析的 evidenceId 与 StatPearls 文档/chunk 定位。该 Trace 的 sourceUri 均为 null，因此可核验本次请求内的 ID 和内部文档定位，但不能验证外部 URL 是否可打开，也不能由此推出医学主张受支持。

## 每次回答需冻结的关联记录

在不混入患者 Memory 与外部语料的前提下，为每次回答保留：

- requestId、traceId、corpusVersion、manifestSha256、answerSha256。
- 同次请求的 EvidenceSet 中每个 evidenceId、source、sourceDocumentId、chunkId、snippet/content hash、sourceUri（未知时为 null）。
- 逐条医学事实主张 claimId 与 claimText；每条主张的 citedEvidenceIds。
- 若回答引用具体句段，保存该 EvidenceHit 的稳定 ID 与被引用的 snippet 范围或 snippet hash。若没有可定位 span，记录为缺失，不猜测位置。
- 无答案、拒答或工具失败等状态；失败任务仍保留在任务分母中。

回答内引用只能解析到同一 requestId 的 EvidenceSet。不得把别的 Session、患者 Encounter/Memory 或另一次检索中的 Evidence ID 当作当前证据。

## 分层指标与分母

| 指标 | 确定性判定 | 分母 |
|---|---|---|
| Evidence ID 完整率 | 回答引用的 ID 是否存在于同一响应的 EvidenceSet | 全部引用 ID |
| 来源定位完整率 | 已解析 ID 是否同时映射到冻结 corpus 的 source、sourceDocumentId 和 chunkId | 已解析 ID |
| 外部出处可解析率 | sourceUri 非空且 URI 规范化后可解析；未提供 URI 记为不可解析，不推断 | 已解析 ID |
| 医学主张引用覆盖率 | 每条需证据支持的医学事实主张至少关联一个当前 Evidence ID | 全部需引用医学事实主张 |
| 引用支持率 | 独立审核者判断所引片段对该 claim 为 direct support；partial 单独统计 | 有引用的 claim–evidence 对 |
| 无依据主张率 | 所引证据不支持或与 claim 冲突的主张比例 | 全部已审核医学事实主张 |

同时报告分子、分母、缺失项、失败状态和按 source 分层结果。外部出处可解析率不等于医学正确性；ID 完整率也不等于 claim support。未回答或拒答单独报告，不把不存在的引用计成有效引用。

## 人工审核与盲化

两位审核者独立查看 claim、被引用 EvidenceHit 的实际片段及必要的来源元数据，按 supported / partial / unsupported / unclear 标注。先统计分歧和一致率，再对分歧进行人工 adjudication。审核者看不到 Single/Integrated 或检索方法标签。模型可以协助整理候选主张，但模型输出不能替代独立审核，也不得描述成医生审核。

若来源或临床适用性不能自动核实，标记 unclear 并保留人工状态；不得依据语料名称把来源写成权威指南。

## 本轮实测 Trace 的解释

H2-P-001 的 Health Engine Trace 已证明单次请求从 query hash 到 20 个候选、3 条 EvidenceHit 和 EvidenceSet response hash 的追踪链路。3 个 ID 分别定位到 StatPearls 的 article-25895/chunk-19、article-41082/chunk-8、article-24883/chunk-45；它们没有 sourceUri。Trace 中没有最终回答或 claim 引用，故本轮 Evidence ID 完整率、引用覆盖率和医学主张支持率均为不可测，不能填 0% 或 100%。

结构化摘要见 H2-TRACE-EXAMPLE.json；包含 snippet 的原始本机 Trace 保存在 Git-ignored Health Engine data 目录中。

## 后续启用条件

待 12 题 A–E 检索 Pilot 完成 qrels 后，再冻结一个小型 answerable query 子集和回答模型/配置。生成回答时启用逐 claim 引用 trace，双人盲审后才能计算支持率。补齐 sourceUri 或来源登记表属于出处解析改进，必须单独报告，不能回填成医学支持率提升。
