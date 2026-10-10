# 本机知识库接入方案与现状

## 建议架构

本项目现有 RAG 数据面是本机 Health Engine + FAISS，不需要先引入 Milvus，也不需要为了检索启动 Docker Desktop。MedCorp 的文本语料可离线规范化、分块、生成向量和索引；Gateway 仍只通过一个 `search_medical_evidence` 工具调用 Health Engine。FAISS 索引按语料保留来源和版本，Health Engine 在同一次检索中读取配置的多个索引。

将数据分为两条完全不同的路径：

1. **医学参考语料和院内知识文档：** 教材、指南、流程规范等按来源建立独立 corpus/index，检索结果带文档、章节、版本、发布日期和原始出处。可进入 RAG 证据检索。
2. **患者 EMR / Encounter：** 按经认证的患者身份和当前就诊请求读取，只注入当前授权上下文。不要把患者档案批量嵌入 MedCorp 或共享 FAISS 索引；患者长期记忆也继续与外部医学证据分开。

如果“慧宜医院数据库”是院内制度、指南或诊疗流程文档，它适合作为一个单独的 `huiyi_hospital` corpus，与 Textbooks/StatPearls 等并列索引。如果它包含患者病历，则应先做受控的患者上下文 API，不进入通用向量库。确认数据类型和授权范围后再对接源文件。

## 语料优先级

- 首批用可核验来源的 Textbooks、StatPearls，以及当前已下载的 PubMed 摘要样本；记录它们目前只是本机快照/部分下载。
- Wikipedia 可作为低优先级背景资料单独标识，不应与指南或同行评审文献混成同一权威等级。
- 先建立小型验证集和出处核验流程，再扩大索引；大规模 PubMed/Wikipedia 不应在每次启动时处理。

## 当前项目契约

- `CorpusRepository` 加载符合 manifest 的 chunk JSONL、FAISS 索引和 metadata；chunk 至少有 `title`、`content`，索引和来源分开记录。
- 当前生产 RAG 实现使用 MedCPT Query/Article Encoder 和 FAISS 内积检索。查询编码器与建库编码器必须匹配；Qwen3-Embedding-0.6B 不能直接查询现有 MedCPT 向量。改用 Qwen 需要新增明确的 encoder adapter、按同一模型重建索引并重新做检索评测。
- `scripts/rag/build_index.py` 需要本地 MedCPT Article Encoder 和已规范化的 chunk JSONL；`scripts/rag/prepare_corpus.py` 生成 manifest，不负责从任意 NXML/PDF 自动解析和清洗。
- 单机先用 FAISS 便于检查版本、磁盘占用和语料隔离。只有需要多进程共享索引、远程服务、多租户管理或在线更新时，再比较 Milvus/Qdrant 等服务型向量库。

## 本机盘点

检查时，`E:\Health-Copilot-Models\MedCorp` 下有 Textbooks、StatPearls、PubMed、Wikipedia。Textbooks/PubMed/Wikipedia 含 MedRAG 风格 JSONL 分块；StatPearls 是 NXML 与图片/视频文件。目录大小约为 Textbooks 0.20 GB、StatPearls 2.52 GB、PubMed 0.53 GB、Wikipedia 1.47 GB；PubMed 与 Wikipedia 是部分数据。模型目录有 Qwen3-8B 和 Qwen3-Embedding-0.6B。

在当前仓库和上述数据根目录中没有找到慧宜医院患者数据库、院内 corpus manifest 或已建 RAG 索引。需要用户确认“医院数据库”文件/服务位置和类型后才能接入。

MedCPT Query/Article Encoder 已下载并整理到 `E:\Health-Copilot-Models\models\MedCPT-Query-Encoder` 与 `E:\Health-Copilot-Models\models\MedCPT-Article-Encoder`，主权重 SHA-256 已校验。模型不放在仓库工作树中；MedCorp 原始语料留在 `E:\Health-Copilot-Models\MedCorp`，本机派生的 JSONL、FAISS 索引和 manifest 留在被 Git 忽略的 `services/health-engine/data/local-rag`。

Health Engine Python 依赖现已安装在 `services/health-engine/.venv` 隔离环境中，该环境复用本机 CUDA Torch，不改全局 Anaconda。RAG 单测 11 项通过。完整 Textbooks 分块（125,847 chunks）及 PubMed 首个分片（15,377 chunks）已生成 MedCPT 768 维 FAISS 索引；manifest 版本为 `medtext-local-d7ac7e27faf8f0c3`，合计 141,224 chunks。Health Engine `/health` 与 `/v1/rag/status` 返回就绪；一条本地 iterative 检索实测完成 2 轮、4 次检索调用、2 次 Qwen 规划调用，并返回 3 条 Textbooks 证据。FAISS 方案不要求 Docker Desktop 或 Milvus。

Gateway 已切换到本机 Qwen3-8B GGUF，前端与 Gateway 健康；合成病例的 DSH E2E 调用了 `search_medical_evidence` 和 `consult_clinical_team`，返回 3 条证据并完成 6 个 MDAgents-derived 子运行。仅本地测试开启的 synthetic-only AMA 记忆完成写入，并在同一合成患者第二轮召回了 2 条记忆；另一位合成患者首次召回为空。该验证证明本机链路可工作，不代表 300 档案全量评估或临床准确性验证。

Windows 本机模型路径固定为：

```powershell
$env:HUIYI_RAG_QUERY_ENCODER_PATH = 'E:\Health-Copilot-Models\models\MedCPT-Query-Encoder'
$articleEncoderPath = 'E:\Health-Copilot-Models\models\MedCPT-Article-Encoder'
```

查询编码器路径由 Health Engine 使用；建库时把 `$articleEncoderPath` 传给 `scripts/rag/build_index.py --article-encoder-path`。查询和建库必须使用这对相互匹配的 MedCPT 模型。

## 本机闭环顺序

1. 页面证据抽屉的浏览器验收仍待进行；目前已通过本机 Gateway SSE/API 完成实际证据检索与工具调用。
2. StatPearls NXML 尚需离线解析与清洗，之后再单独建 corpus；Wikipedia 保持低优先级并明确其部分下载状态。
3. 慧宜医院数据仍待确认数据类型、授权范围和源路径。若为临床制度或指南，作为单独的 `huiyi_hospital` corpus；若包含患者 EMR，必须走认证授权的患者上下文接口，不进入共享 FAISS。
4. 300 个合成患者的生成审核、Simulation Lab、长跑评测及完整 MDAgents/AMA/i-MedRAG 覆盖报告仍是待实现工作；当前只做了少量本机合成患者链路验证。
5. 逐步扩大 corpus 分片并记录索引空间、内存、召回质量和出处覆盖；不在 live request 中构建或更新索引。

Linux 部署示例见 [`examples/local-rag.env.example`](../../examples/local-rag.env.example)，其中 Linux 路径仅适用于训练机。本机 Windows 的 MedCPT 模型使用上面的 E 盘路径；corpus/index 路径仍使用项目 `services/health-engine/data/local-rag` 下的忽略目录。
