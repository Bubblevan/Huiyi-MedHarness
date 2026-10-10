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

当前 Windows Python 为 3.12.4，含 CUDA Torch 与 Transformers 4.44.2；缺少 FastAPI、Uvicorn、FAISS、sentence-transformers 和 tiktoken。当前本机还没有 MedCPT Query/Article Encoder，也没有可供 Health Engine 读取的已建 MedCPT 索引。Health Engine 的 `127.0.0.1:8322` 当前拒绝连接。Docker CLI 存在，但 Docker Desktop Linux Engine 当前未启动；当前 FAISS 方案无需 Docker。

前端 `127.0.0.1:5173` 和 Gateway `127.0.0.1:8320` 当前健康，Gateway 使用 DSH + DeepSeek API。RAG 的本机闭环尚未完成：缺少匹配的 MedCPT 编码器、准备好的 chunk/index/manifest，以及 Health Engine Python 运行依赖。不要把“Gateway/模型正常”误认为“知识库已接好”。

## 本机闭环顺序

1. 明确慧宜医院数据属于院内知识文档还是患者 EMR，并确认本机源路径、格式、授权和是否脱敏。
2. 选定检索 encoder。若保持当前 MedCPT 契约，取得与产品版本匹配的 Query/Article Encoder；若改用本地 Qwen3-Embedding，则先实现新 adapter 和一致的文档/查询编码，再重建向量索引。
3. 将一小组 Textbooks/StatPearls chunk 和院内知识文档整理为项目规定的 JSONL、FAISS 索引、metadata 和 manifest；患者 EMR 仍不进入此步骤。
4. 在隔离的本机 Python 环境启动 Health Engine，确认 `/health` 与 `/v1/rag/status`，再让当前 Gateway 的 `search_medical_evidence` 完成一次本地检索；页面证据抽屉显示来源、版本和引用。
5. 逐步扩大到已下载的 corpus 分片，记录索引空间、内存、召回质量和出处覆盖；不在 live request 中构建或更新索引。

运行配置示例见 [`examples/local-rag.env.example`](../../examples/local-rag.env.example)。其中的 Linux 路径针对原来的训练机；Windows 本机要改成实际本机语料、manifest 和 MedCPT 模型路径后才能运行。
