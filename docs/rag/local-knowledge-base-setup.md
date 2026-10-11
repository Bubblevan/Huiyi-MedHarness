# 本机知识库接入方案与现状

## 建议架构

本项目现有 RAG 数据面是本机 Health Engine + FAISS，不需要先引入 Milvus，也不需要为了检索启动 Docker Desktop。MedCorp 的文本语料可离线规范化、分块、生成向量和索引；Gateway 仍只通过一个 `search_medical_evidence` 工具调用 Health Engine。FAISS 索引按语料保留来源和版本，Health Engine 在同一次检索中读取配置的多个索引。

将数据分为两条完全不同的路径：

1. **医学参考语料和院内知识文档：** 教材、指南、流程规范等按来源建立独立 corpus/index，检索结果带文档、章节、版本、发布日期和原始出处。可进入 RAG 证据检索。
2. **患者 EMR / Encounter：** 按经认证的患者身份和当前就诊请求读取，只注入当前授权上下文。不要把患者档案批量嵌入 MedCorp 或共享 FAISS 索引；患者长期记忆也继续与外部医学证据分开。

如果“慧宜医院数据库”是院内制度、指南或诊疗流程文档，它适合作为一个单独的 `huiyi_hospital` corpus，与 Textbooks/StatPearls 等并列索引。如果它包含患者病历，则应先做受控的患者上下文 API，不进入通用向量库。确认数据类型和授权范围后再对接源文件。

## 语料优先级

- 当前统一索引已经包含 Textbooks、StatPearls、部分 PubMed、部分 Wikipedia 和慧宜医院官网公开资料；清单和数量见“当前本机索引”。
- PubMed/Wikipedia 的本机下载仍是子集。Wikipedia 应作为背景材料区分标注，不与指南或同行评审文献混成同一权威等级。
- 扩充语料前先检查本机磁盘、内存、索引空间和语料来源；不在服务启动时下载或重建大型索引。

## 当前项目契约

- `CorpusRepository` 加载符合 manifest 的 chunk JSONL、FAISS 索引和 metadata；chunk 至少有 `title`、`content`，索引和来源分开记录。
- 当前运行的 RAG 使用 `Qwen3-Embedding-0.6B` 和 FAISS；索引由 `scripts/rag/build_qwen3_index.py` 构建，Health Engine 从 manifest 读取与索引匹配的 encoder。MedCPT 索引若切回运行，必须使用与其建库向量匹配的 MedCPT Query Encoder，不能混用 Qwen 向量。
- `scripts/rag/prepare_corpus.py` 生成 manifest，不负责从任意 NXML/PDF 自动解析和清洗；原始语料解析、分块及每个 encoder 的向量索引应分阶段执行。
- 单机先用 FAISS 便于检查版本、磁盘占用和语料隔离。只有需要多进程共享索引、远程服务、多租户管理或在线更新时，再比较 Milvus/Qdrant 等服务型向量库。

## 当前本机索引

当前 Health Engine `/v1/rag/status` 返回 `ready`，corpus version 为 `medtext-local-cc7d43568501e6b7`，使用 `Qwen3-Embedding-0.6B`，共 5 个来源、823,450 chunks。活动 manifest 为 `services/health-engine/data/local-rag-hc-rag-002/qwen3-corpus-manifest.json`，大小约 1.67 MB，SHA-256=`CCC89D1F6DEEF68536647541FBAD6C79C98F7185CFBE2CD0C00698B15F5B37CF`。来源拆分如下：

| 来源 | manifest `documentCount`（chunk JSONL 文件数） | chunks | 覆盖说明 |
| --- | ---: | ---: | --- |
| Textbooks | 18 | 125,847 | 本机 Textbooks 快照 |
| StatPearls | 9,651 | 384,050 | 已进入活动索引 |
| PubMed | 23 | 280,070 | 23 个可用 chunk JSONL 分片；本机部分快照，不是 PubMed 全量 |
| Wikipedia | 5 | 33,414 | 5 个可用 chunk JSONL 分片；本机部分快照，不是 Wikipedia 全量 |
| Huiyi | 59 | 69 | 59 个 chunk JSONL 文件，来自慧宜眼科医院官网公开页面；不是院内 EMR 或患者数据库 |
| **总计** | **9,756** | **823,450** | 活动 Qwen3-Embedding FAISS 索引 |

**2026-10-11 文件级核验：** 使用 `scripts/rag/verify_index.py` 对活动 manifest 声明的五个来源、所有 chunk JSONL、FAISS 索引及 metadata 做 SHA-256/计数校验，结果 `status=verified`，版本 `medtext-local-cc7d43568501e6b7`，823,450 chunks，核验资产合计 4,717,040,705 bytes。可复核报告为 [`qwen3-index-20261011.json`](../../artifacts/rag-index-verifications/qwen3-index-20261011.json)，其中保存逐来源 chunk/文件数、index hash 和 manifest SHA-256。读取核验期间空闲 RAM 抽样为 18.3→17.8→18.3 GiB，C/D/E 空间未见变化；没有重建索引、下载模型/语料或启动生成模型。

**计数口径：** 当前 `prepare_corpus.py` 把每个来源目录下的 chunk `*.jsonl` 文件数写入 manifest 的 `documentCount` 字段；9,756 不是独立论文/网页数。PubMed 与 Wikipedia 的本机来源 revision 分别记载 23 和 5 个可用分片。

按索引 chunk 计数，Textbooks + StatPearls 为 **509,897**（约 **50.99 万**）；五源统一索引总计 **823,450**。这个口径是向量索引中的 chunk 数，不表示独立医学结论或经临床审核的有效证据数。

Huiyi 网站采集来源、范围和校验记录见 [`huiyi-corpus.md`](huiyi-corpus.md)。这批公开资料包含院方、科室、医生及患者教育页面；患者教育页的来源审核状态仍需遵循该文件中的标记，不能当作临床指南。没有证据表明患者病历数据库已接入。

MedCorp 原始语料保留在 `E:\Health-Copilot-Models\MedCorp`；Qwen3-Embedding 模型位于 `E:\Health-Copilot-Models\models\Qwen3-Embedding-0.6B`。派生 chunk、FAISS index 和 manifest 位于被 Git 忽略的 `services/health-engine/data/local-rag-hc-rag-002`，索引构建不会覆盖原始语料或 MedCPT 文件。MedCPT Query/Article Encoder 仍保存在 E 盘，可作为独立、匹配的 encoder 路线，不是当前活动 manifest 的 encoder。

最近一次 DSH→Health Engine 单轮 RAG smoke 使用 Codex app-server 的 GPT-6-Luna 生成，返回 3 条 StatPearls evidence，RAG single retrieval 为 257.2 ms、无 planner 降级；双语非生成 smoke 也曾命中 PubMed/StatPearls。Qwen3-8B 未用于当前生成路径。以上检索命中数和耗时不构成证据相关性、答案支持率或医学准确率。

## 尚需完成

1. PubMed `documentCount=23`、Wikipedia `documentCount=5` 表明两者仍为局部快照；继续下载前先由用户决定范围，并复核磁盘、内存和模型/服务负载。现有 823,450 chunks 已可用于本机检索，不需要为启动服务开启 Milvus 或 Docker Desktop。
2. 当前没有接入患者 EMR。患者身份与 Encounter 必须继续通过认证授权的患者上下文接口隔离，不能进入共享 FAISS。
3. 300 例/2,400 项 synthetic cohort 已生成，Gateway 授权 sweep 和多条单例 DSH/RAG/AMA/协作运行已有工程证据；大规模 Luna 多轮评测与临床盲审成绩仍未完成，cohort 审核状态仍为 pending。
4. 所有扩容/重建均应离线分批进行，记录 source manifest、chunk 数、index 磁盘占用、RAM/VRAM 快照和 retrieval evidence provenance；不在 live request 中构建索引。

Linux 部署示例见 [`examples/local-rag.env.example`](../../examples/local-rag.env.example)，其中 Linux 路径只适用于目标训练机。本机 Windows 模型放在 `E:\Health-Copilot-Models\models`，corpus/index 使用上述被 Git 忽略的本机数据目录。
