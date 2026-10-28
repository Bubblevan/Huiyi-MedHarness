# Huiyi 简历 Bullet 2｜医学知识检索首版证据

## 已核实的数字

- 当前活动的五源 `Qwen3-Embedding-0.6B + FAISS` 索引验证状态为 `verified`，共 **823,450 个 chunks**，来源为 Textbooks 125,847、StatPearls 384,050、PubMed 280,070、Wikipedia 33,414、慧宜医院官网公开资料 69；manifest 指定的索引与 metadata 资产共 4,717,040,705 bytes。
- 当前五源索引的本地检索 smoke：独立的英文/中文 single-pass **2/2 通过**，均各返回 3 条来源证据；另一次中文 iterative RAG **1/1 通过**，两轮生成 4 个查询、检索 4 次，从 12 个候选归并 9 篇文献后返回 3 条 PubMed evidence，未降级。此前一组双语 iterative smoke 为 **1/2**，中文回退为 single；后续单独中文重试通过，因此不将不同批次合并为“3/3 稳定率”。Single-pass 不调用生成模型；iterative planner 使用 GPT-6-Luna。
- 独立的 MedCPT 上游复现：冻结 100 条 MedQA 验证查询，Top-1 匹配率、Top-32 重合率和排序一致率均为 **100%**，分数最大绝对差为 0。这组 parity 使用 **509,897 chunks 的 Textbooks + StatPearls 旧快照**，不是当前 823,450 chunk 五源索引。
- 同一旧快照上的 45 题 Qwen3-8B A/B/C 验证：pinned MedRAG 上游 35/45（77.78%），Huiyi Health Engine direct 37/45（82.22%），DSH AgentLoop 31/45（68.89%）。Direct 相对上游的点估计 +4.44 个百分点，但配对 95% 区间跨 0；DSH 相对 direct 低 13.33 个百分点，parity gate 未通过。它不能证明现役五源索引的答案准确率提升。

## 尚未得到的指标

**证据支持率、医学断言证据覆盖率和引用正确率尚未测量。** 当前 823,450 chunk smoke 只执行检索，没有生成答案；100-query parity 只比较召回结果与上游是否一致；45 题问答评分的是 MedQA 选择题准确率，而不是证据支持或引用正确性。不能把 100% 检索 parity 写成 100% 医学证据支持，也不能填写目标中的 79%→92% 或 95%。

另核对了已有浏览器 E2E：链路完成并返回 3 条 evidence、3 条草稿 evidence，但结果文件只保存状态和计数，`rawConversationContentInResultArtifact` 为 `false`，没有可复核的回答正文或证据片段；因此不能从这 1 次 E2E 推算引用正确率。检索 smoke 结果也只保存查询哈希、来源和计数，不包含答案或 passage 正文。

这组结果足以在简历中写清楚**索引规模、五源组成、当前检索链路 smoke 和独立上游兼容性**。暂不把 45 题的 +4.44pp 写成显著的医学问答提升，也不将旧快照指标与当前五源索引合并成一个准确率。

## 推荐简历 Bullet（当前可核实版本）

构建并验证基于 Qwen3-Embedding-0.6B 与 FAISS 的五源医学知识索引，覆盖教材、StatPearls、PubMed、Wikipedia 及慧宜医院官网公开资料，共 823,450 个文本片段；当前索引英文/中文 single-pass 检索 smoke 2/2 通过，另完成一次两轮迭代检索；并在独立 MedCPT 509,897 段旧快照的 100 条冻结查询上复现 pinned MedRAG Top-1、Top-32 与排序结果（匹配率均 100%）。

## 复现来源与范围

- 当前索引 verifier：[qwen3-index-20261011.json](../../artifacts/rag-index-verifications/qwen3-index-20261011.json)
- 当前 single-pass smoke：[rag-single-20261011-082052.json](../../artifacts/clinical-eval/rag-smokes/rag-single-20261011-082052.json)
- 当前 iterative smoke：[rag-iterative-20261011-070402.json](../../artifacts/clinical-eval/rag-smokes/rag-iterative-20261011-070402.json)
- 已有浏览器 E2E 状态计数（不含原始回答/证据正文）：[browser-e2e-20261011-225644-c5a5caac.json](../../artifacts/clinical-eval/browser-e2e/browser-e2e-20261011-225644-c5a5caac.json)
- 旧快照 100-query retrieval parity：[retrieval-parity.json](../../artifacts/hc-rag-002/retrieval-parity.json)
- 旧快照 45-case live QA 汇总：[validation-parity-45-metadata.json](../../artifacts/hc-rag-002/validation-parity-45-metadata.json)
- 运行和数据切片限制：[eval/rag-parity/README.md](../../eval/rag-parity/README.md)

所有当前索引检索 smoke 都是固定通用医学查询；检索返回来源不等于医生确认其支持了某个答案。没有下载、重建索引、启动服务或发起新模型请求。
