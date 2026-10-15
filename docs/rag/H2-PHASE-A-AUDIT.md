# H2 医学 RAG 检索与评测增强：Phase A 源码与评测审计

审计日期：2026-10-15  
仓库 HEAD：`28ba197ed3499272efdfaeda20645be7300ec796` (`codex/demo-edge-local-001`)  
审计范围：只读检查；未修改 RAG 产品行为，未启动模型、服务或新实验，未下载语料/模型。

## 1. 实际代码位置与检索链路

TRD 中提到的 `rag/retriever.py` 等文件，实际位于 `services/health-engine/src/huiyi_health_engine/rag/`。`src/rag/` 是 TypeScript 的 DSH 工具契约/客户端/trace 层，不是向量检索实现。

| 步骤 | 实际实现 | 输入与输出/当前边界 |
|---|---|---|
| 请求校验 | `rag/schemas.py:MedicalEvidenceRequest` | `query` 去首尾空格，长度 1–4000；`mode` 为 `single` 或 `iterative`；`topK` 为 1–10；拒绝额外字段。患者 Encounter/Memory 不属于此请求。 |
| 语料载入 | `rag/corpus.py:CorpusRepository.load` | 读取一个 corpus manifest；验证源、chunk、FAISS index 与 metadata 的计数/哈希并一一对应；FAISS 必须是 inner-product index。返回 `PreparedCorpus`，每个来源保持独立索引。 |
| Query 编码 | `rag/retriever.py` | 根据单一 manifest 选择 MedCPT 或 Qwen3。Qwen3 使用医疗检索 instruction、last-token pooling、L2 normalization；MedCPT 使用 CLS pooling。Health Engine 检查本地 query encoder revision 与 manifest 一致。 |
| Dense 候选召回 | `MedCptRetriever.search`（Qwen3 继承其 `search`） | 对每个来源索引各取最多 `top_k` 个，再汇总；按向量内积降序、稳定 chunk ID 升序打破并列，最后全局截为 `top_k`。这是全来源共享的最终候选数，不是每个语料分别返回 `top_k`。 |
| 可选查询迭代 | `rag/iterative.py` + `rag/planner.py` | 每轮由本地 OpenAI-compatible planner 产生 1–`max_queries_per_round` 个查询；后续轮可看到上一轮候选片段。每个查询独立执行 Dense 搜索。相同 stable ID 去重，保留最高原始 Dense 分数，记录出现过的查询及最早轮次；最终仍按最高 Dense 分数降序、stable ID 升序。Planner 不生成最终回答。 |
| EvidenceSet 选择 | `rag/service.py:RagService._select_evidence` | 按候选顺序最多检查 `max(limit*4, limit)` 条；受 `max_evidence_tokens` 限制，必要时截断 snippet；为来源、文档、chunk 和内容生成稳定 evidence ID，返回 `EvidenceHit[]`。Health Engine 输出 `EvidenceSet`，最终回答仍归 DSH。 |

当前默认配置（可由环境变量覆盖）：默认 `single`；最多 2 轮、每轮最多 2 个 planner query、每 query 3 个候选、最多返回 3 条、证据上下文预算 2,048 tokens、请求超时 180 秒。`single` 一次 FAISS 检索、0 次 planner 调用；默认上限下 `iterative` 最多 4 个 planner query / 4 次内部 Dense 检索、最多 12 个候选出现次数，合并去重后按证据 token 预算返回最多 3 条。请求或运行时可设更高上限，具体值需随每个评测运行冻结。

主要结构：`CorpusChunk`（corpus/source document/chunk/title/content/URI）、`CorpusIndex`（单来源 FAISS + metadata + chunk store）、`PreparedCorpus`（单版本、单 encoder revision 的多来源索引）、`RetrievalCandidate`（chunk/score/query/round）、`AccumulatedCandidate`（最佳候选/首轮/查询列表）、`EvidenceHit` 与 `EvidenceSet`。目前 chunk/source 元数据没有独立且可信的文献类型、语言、文档版本、发布日期、适用条件或适用性审核字段；部分上游 revision 信息保存在 manifest source 层。

## 2. 当前没有的组件

### 全链路架构图

`mermaid
flowchart LR
  Clinician[Clinician query] --> DSH[DSH outer AgentLoop]
  DSH -->|query-only medical evidence request| Contract[Health Engine request validation]
  Contract --> Corpus[CorpusRepository validates manifest, chunk map and FAISS]
  Corpus --> Encoder[Qwen3-Embedding-0.6B query encoder]
  Encoder --> Dense[Per-source FAISS inner-product retrieval]
  Dense --> Mode{single or iterative}
  Mode -->|single| Rank[Deduplicate and rank final Top-K]
  Mode -->|iterative| Planner[Local OpenAI-compatible planner creates search queries only]
  Planner --> Encoder
  Rank --> Select[EvidenceSet selector: token budget, stable evidence IDs]
  Select -->|EvidenceSet, not final answer| DSH
  DSH -->|final answer and tool orchestration| Clinician
  DSH <-->|separate patient context tools| PatientContext[Encounter and AMA Memory]

  subgraph OfflineEvaluation[Offline H2 evaluation only]
    ExistingChunks[Existing five-source chunks] --> BM25[SQLite FTS5 BM25]
    Dense --> RRF[Fixed-budget RRF]
    BM25 --> RRF
    RRF --> BGE[BGE cross-encoder reranking]
    BGE --> Pool[Blinded pooled qrels review]
    Dense --> IterativeE[Bounded iterative E arm]
    IterativeE --> Pool
  end

`

The product request contains the evidence query, not patient Encounter or Memory payloads. A–D sparse/fusion/reranker branches are evaluation-only in this pilot; the H2 runs do not install them into the Health Engine request path. E uses the same Dense retriever with a bounded query planner and still returns candidates only.

- 当前产品检索链路只有按配置 encoder 的 Dense FAISS inner-product 检索，没有 BM25/Sparse 索引或 Sparse 查询路径。
- 没有 RRF（Reciprocal Rank Fusion）或其他 Dense/Sparse 融合实现。
- 没有集成 Cross-Encoder Reranker；Health Engine Python 依赖中也没有专用 reranker package。机器上可见本地 `E:\Health-Copilot-Models\models\bge-reranker-v2-m3`（2.14 GiB），但“模型文件存在”不等于已集成或已评测。
- `iterative` 是基于 planner 改写/扩展查询、重复执行 Dense 检索并合并候选的策略，不是 BM25、RRF 或 reranker。
- 以上均是检索架构事实；当前实验不应预设这些组件会带来提升。

## 3. 当前五源 Qwen3 活动索引与历史 MedCPT 分离

已核对活动清单 `services/health-engine/data/local-rag-hc-rag-002/qwen3-corpus-manifest.json`。其资产路径相对 corpus root `services/health-engine/data/local-rag-hc-rag-002/corpus`，而不是相对清单文件所在目录。2026-10-11 的逐文件核验记录显示 `status=verified`、manifest SHA-256 `ccc89d1f6deef68536647541fbad6c79c98f7185cfbe2cd0c00698b15f5b37cf`、index hash `3973c79aaee45d77d70997b736bb96e87359fcaa96361b476c549f4cd103a25e`、总计 823,450 chunks、核验资产 4,717,040,705 bytes。

| Source | 文件数（manifest `documentCount`） | chunks | 快照说明 |
|---|---:|---:|---|
| Textbooks | 18 | 125,847 | 本机教材快照 |
| StatPearls | 9,651 | 384,050 | pinned MedRAG 快照 |
| PubMed | 23 | 280,070 | 本机 23 个可用分片，非全量 |
| Wikipedia | 5 | 33,414 | 本机 5 个可用分片，非全量 |
| Huiyi | 59 | 69 | 官网公开资料快照，不是院内 EMR |
| **合计** | **9,756** | **823,450** | 五源 Qwen3-Embedding-0.6B / FAISS |

活动 Qwen3 Query/Article Encoder revision 均为 `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`。独立的 HC-RAG-001/002 和本机旧 `local-rag/corpus-manifest.json` 使用 MedCPT Query/Article Encoder（revision 分别为 `d83a36...` / `d05a73...`），不能和 Qwen 向量混用。旧 `local-rag` manifest 当前只列 Textbooks 125,847 + PubMed 15,377 chunks；它不是五源活动 Qwen corpus。运行必须通过显式 manifest/root 选择并在 trace 冻结版本，不能只凭目录名推断活动 corpus。

本次检查发现无本机 RAG 服务监听配置相关的 8323/8324/8362 端口；因此本轮可确认索引工件及其校验记录，不能声称当前服务进程正在加载该版本。机器资源快照：约 64 GiB RAM、约 27 GiB 可用 RAM、E 盘约 155 GiB 可用、RTX 4090 Laptop 16 GiB 显存中约 196 MiB 已用。未启动服务或模型。

## 4. “10 组循证开发任务”工件完整性

找到的对应工件为 run `resume-b2-20261012053523-609ac99a`：

| 检查项 | 现有证据 | 审计结果 |
|---|---|---|
| 冻结 cohort / split / 模型与版本 | `run-summary.json`；development；source SHA `8aebe5ed0cc990ee3c191839f1cbb9a514879595`；cohort hash `7d70893f...a6310c`；10 个固定 T07 任务；GPT-6-Luna；Qwen3 五源 corpus `medtext-local-cc7d43568501e6b7` | 存在且可追溯；旧运行源码不是当前 HEAD。 |
| 原始输入及生成结果 | `raw-and-blinded-review.json`，10 tasks / 20 attempts；`attempt-rows.jsonl` 20 行 | 文件存在；包含 prompt、两臂答案、检索 trace/evidence IDs、token/耗时等。该目录为 private 工件，原始病例/回答不复制到本审计文档。 |
| 评分标准与结果 | `blinded-score-packet.json`、`blinded-score-agent.json`、`docs/eval/RESUME-B2-FINAL.json` | 10 case / 20 answer；盲化 X/Y 模型辅助评分。复核报告记录任务满足度 1/10→10/10、RAG 9/10 检索到 passage、29/29 同轮引用 ID 可解析；这些是小样本 development 工程指标，不是临床审核。 |
| 执行记录与模型 route | `attempt-rows.jsonl`、`run-summary.json`、`bridge-health-final.json` | 有逐任务记录；bridge 结束时 `status=ok`。没有单独 provider token 费用数据，只有观测 token；不能据此报货币成本。 |
| Retrieval qrels / 相关性等级 | 原始 prompt、输出 evidence 及答案评分中无冻结的相关文档 ID / 0–3 等级 / 适用性审核标签 | **缺失**。因此该 10 题可以作为开发问题来源，但不能直接算 Recall@K、MRR 或 nDCG。 |

早期 6 条试跑已被 `run-status.json` 标成 `invalid-protocol`：gateway 未强制 iterative mode；正确做法是保留但不并入正式指标。2026-10-12 的 5 题引用支持复核报告含 13 条 answer-specific source-claim judgments（8 direct、5 partial），是非独立工程审阅；也不是逐 query 的检索 qrels 或双人标注集。

## 5. HC-RAG-001、HC-RAG-002 与当前五源 Qwen 的差异

| 维度 | HC-RAG-001 | HC-RAG-002 现有验证 | H2 当前目标索引 |
|---|---|---|---|
| Corpus | 93 chunks：Textbooks 60 + StatPearls 33 | 509,897 chunks：Textbooks 125,847 + StatPearls 384,050 | 823,450 chunks，五源；含部分 PubMed/Wikipedia 与 Huiyi 官网公开资料 |
| Encoder / index | MedCPT Query + Article；两份小索引 | MedCPT Query + Article；FAISS `IndexFlatIP` | Qwen3-Embedding-0.6B，同 revision Qwen FAISS 索引 |
| Dataset / split | 6 条产品运行提示；不是答案正确率/检索准确率基准 | MedQA-USMLE validation 子集；45 条 active scope，question/options 投影 | 必须新建 H2 query/qrels；禁止把 HC-RAG-001/002 结果当作该索引的 Recall/MRR 标签 |
| 主要实验目标/结果 | DSH + 本地 Qwen 的工具与 EvidenceSet 集成 smoke；无准确率评估 | A/B/C 为上游 MedRAG、Health Engine direct、DSH；45 条 A=35/45、B=37/45、C=31/45；B→C parity gate failed，停止在 validation，TEST 未打开 | 对同一冻结 H2 评测问题比较 Dense、BM25、Dense+BM25/RRF、Reranker、Iterative；未开始 |
| 可否合并指标 | 否 | 否 | 单独报告 |

HC-RAG-002 45 题的预测、label boundary、MedCPT 全量语料和 Qwen3-8B 答案生成回答的是模型 QA parity；既不是 45 个检索相关性标注，也不是当前 Qwen3-Embedding 五源语料上的检索实验。HC-RAG-001 只有 6 条集成验证提示，也无 gold relevant document IDs。

## 6. Phase B 的数据门槛和建议

应新建一个独立于患者上下文的 query-level 数据集，字段至少包括：`questionId`、query text、language、task category、corpusVersion、冻结候选池、每个来源文档/chunk ID 的相关性等级、适用性判断、reviewer、审核状态、DEV/HOLDOUT split。相关等级建议固定为 0–3（不相关、弱相关、直接相关、关键证据），另将“当前 corpus 无可用答案”作为 query-level no-answer 判定，而不是把某条 chunk 的 0 分误写成“医学上不存在答案”。

先做小 Pilot，覆盖精确术语、语义检索、多跳、双语、来源冲突、无答案。候选池需先冻结、再由至少两名独立审核者标注，并对不一致项保留 adjudication；一致率/Krippendorff’s alpha 等必须从真实独立标注计算。现存 10 个 B2 开发任务缺少上述标签，不能用自评、模型自评或事后挑选 top-k 来伪造一致性。HOLDOUT 的问题和 labels 在 DEV 调参冻结之前保持隔离。

## 7. Phase A 结论

源码、活动 Qwen 索引工件、历史实验与 10 个开发任务已完成审计。当前产品是 Dense FAISS + 可选 iterative query planner，没有 BM25、RRF 或独立 reranker。旧 MedCPT 资产需要保留但与五源 Qwen corpus 严格分开。B2 10 对结果可作为历史回答工作流工程结果，不能替代 H2 的检索 qrels。

**本阶段没有改动任何产品行为、模型、语料或索引。** Phase B 必须先产出 query set 和双人标注 Pilot；在候选问题与相关性标签审核完成前，不能给 H2 消融实验报 Recall/MRR/nDCG 或“证据支持率提升”。
