# HY-CLINICAL-001 — M0 长跑审计

审计日期：2026-10-11（UTC）
仓库 HEAD：`013e21c3814263128c17e2d0ba54a9aa4c331aa7`
运行 ID：`20261011104158-f3ea4e2f`
运行状态：`paused`，在完整病例臂边界暂停；未生成或发布临床评分。

本报告只汇总运行元数据，不复制患者模拟对话、完整助手回答、证据正文或记忆内容。

## 结论

**不建议恢复这次 4,800 轮长跑。** 本次运行已在 HCE-0006 integrated 的 T08 落盘后暂停；下一病例 HCE-0007 未写入结果。暂停时 96 条结果均可解析且 `runId` 唯一。继续恢复会被运行器的源码指纹保护拒绝：冻结指纹记录的是 `492595785b61ab795e60588212997a646a805aa2`、dirty worktree 和 123 个源码路径；当前 HEAD 为 `013e21c3814263128c17e2d0ba54a9aa4c331aa7`，当前指纹为 `d255508a1fd8ead61a650c23a3723b11c62d4fb800eac580340a6932edaf2a12`、clean worktree、122 个路径。源码路径变更中包含 `fixtures.ts` 到 `demo-seed/patients.ts` 的重命名。运行器要求完整指纹逐字段相同，因此不应改写原始指纹或绕过校验。

即使忽略恢复阻塞，HCE-0006 集成臂的 8 个任务中有 6 个失败，且失败集中在 240–300 秒长尾；两个成功轮次没有工具调用或证据。所有病例仍是待审核合成数据，`review-packets.jsonl` 没有记录、clinical approval 为空。因此本运行只能作为工程诊断，不能支撑临床任务完成率或系统效果提升结论。

建议保留此运行作为故障基线；在修复运行时问题、完成 M1 可审核复诊草稿、取得有资格审核者对 development packet 的真实审核后，用**新 run ID**先做两例集成完整性回归，再做小规模配对质量试验。不得将本次局部执行结果写成临床指标。

## 运行配置与落盘范围

| 项目 | 记录值 |
|---|---|
| Cohort | `artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl`，SHA-256 `7d70893f2ffab9f8711f5ac260a1f70729bef758fb41f7cae50afaa894a6310c` |
| Cohort 选择 | 300 例（development 30 / validation 75 / held-out 195），`split=all`，`adaptive` patient simulation，follow-up cap 1 |
| 计划量 | 4,800 个 patient task turns；assistant exchanges 上界 9,600 |
| 双臂 | `single-agent` 与 `integrated`，患者/轮次配对 |
| 推理路由 | `codex-app-server`，provider `huiyi-demo-local-codex`，model `gpt-6-luna`，`http://127.0.0.1:8355/v1` |
| 生成限制 | 每次生成最多 384 tokens；context window 40,960；turn timeout 300,000 ms |
| 集成组 Health Engine | `http://127.0.0.1:8356`；AMA/RAG planner 路由到 GPT-6-Luna；Qwen3-Embedding-0.6B；检索启用、Memory recall isolation 启用 |
| Health Engine 源码指纹 | `fe025d59b70e5298d1038d5e4d4ede4beb590b5569054dc693746d431355a2c7` |
| RAG 元数据 | planner prompt `huiyi-rag-query-plan-v1`；已记录 corpus version `medtext-local-cc7d43568501e6b7` |
| 运行时 | Node `v22.20.0`，Windows x64 |
| 审核门 | `clinicalApprovalArtifact=null`；所有运行行 `clinicalReviewStatus=pending` |

GPT-6-Luna 的底层模型构建版本不可由当前 Codex bridge 获取；manifest 未保存 GPT 模型 revision、独立 prompt-template hash、Qwen embedding 文件 hash 或被检索 corpus/index 的完整内容 hash。RAG 的 `corpusVersion` 是当前记录到的 corpus 标识，不替代完整数据快照指纹。manifest 的 `hardware` 字段为空；本报告将运行停止后的机器状态单独列为审计快照。

## 准确分母、配对与失败

| Arm | 记录数 | Completed | Failed | Cancelled | 记录完成率（工程状态） |
|---|---:|---:|---:|---:|---:|
| Single-agent | 48 | 47 | 1 | 0 | 97.9% |
| Integrated | 48 | 42 | 6 | 0 | 87.5% |
| 合计 | 96 | 89 | 7 | 0 | 92.7% |

上述“记录完成率”仅表示执行状态，不是临床任务完成率。

- HCE-0001 至 HCE-0006 均有两臂各 8 条记录，覆盖 **48/48 个同病例同轮次配对槽位**；每条 `runId` 唯一，没有重复 accepted row。
- HCE-0001 至 HCE-0005 的两臂各 8/8 全部完成：**5 个完整成功的配对病例、10 个完整 case-arm task**。
- HCE-0006 两臂都写满 8 个槽位，但 single-agent 为 7 成功/1 失败，integrated 为 2 成功/6 失败；因此它不属于两臂全成功病例。
- 此前“91 条、集成组 41 + 单体组 48”的汇报把集成组已完成数与记录总数混用了。91 条时集成组实际为 43 条（41 completed + 2 failed），加单体组 48 条才是 91。此后又写入 HCE-0006 integrated T04–T08 五条，暂停快照达到 96 条（42 completed + 6 failed integrated；47 completed + 1 failed single-agent）。
- `attempt-history.jsonl` 另有 5 条被重试前的 HCE-0003 integrated 记录（4 completed、1 failed）；它们是历史 attempt，不计入上述 96 条当前 accepted rows。清单记载一次 resume：保留 5 个已完成 case-arm task，595 个仍待运行。
- 本轮所有 7 个失败都在 HCE-0006：4 个 `TURN_TIMEOUT`（integrated T01、T05、T06、T07），3 个 `MODEL_FAILURE` / provider code `SERVER`（single-agent T05；integrated T02、T04）。没有取消状态。
- HCE-0006 integrated 的 T03、T08 虽标记 completed，但均为 0 个工具调用、0 条证据；不能视作完整 RAG/协作链路成功。

## 最慢的 10 个任务

| 排名 | Case / Arm / Turn | 状态 | 总耗时 | DSH 耗时 | 主要可见耗时组件 |
|---:|---|---|---:|---:|---|
| 1 | HCE-0006 / integrated / T03 | completed | 300.013 s | 249.981 s | DSH 约 250 s；约 50 s 在 DSH 计时之外，分项未记录；无工具/证据 |
| 2 | HCE-0006 / integrated / T06 | failed | 300.013 s | — | 300 s turn timeout |
| 3 | HCE-0006 / integrated / T05 | failed | 300.011 s | — | 300 s turn timeout |
| 4 | HCE-0006 / integrated / T08 | completed | 300.011 s | 267.697 s | DSH 约 268 s；约 32 s 在 DSH 计时之外；无工具/证据 |
| 5 | HCE-0006 / integrated / T07 | failed | 300.011 s | — | 300 s turn timeout |
| 6 | HCE-0006 / single-agent / T08 | completed | 300.006 s | 245.258 s | DSH 约 245 s；约 55 s 在 DSH 计时之外 |
| 7 | HCE-0006 / integrated / T01 | failed | 300.004 s | — | 300 s turn timeout |
| 8 | HCE-0006 / single-agent / T04 | completed | 245.100 s | 245.064 s | DSH 执行约 245 s |
| 9 | HCE-0006 / single-agent / T07 | completed | 243.595 s | 243.561 s | DSH 执行约 244 s |
| 10 | HCE-0006 / single-agent / T05 | failed | 240.131 s | — | Provider `SERVER` failure；发生在 bridge 的 240 s RPC timeout 配置附近 |

因失败记录没有 DSH 子计时，失败耗时只能归为 turn/provider 等待，不能再细分为模型服务、队列或网络耗时。成功记录中 `wallTimeMs - dshDurationMs` 的差值是 DSH 计时外开销；当前没有更细的阶段计时。

| Arm | P50 总耗时 | P95 总耗时 | 最大值 |
|---|---:|---:|---:|
| Single-agent | 8.70 s | 243.60 s | 300.01 s |
| Integrated | 20.07 s | 300.01 s | 300.01 s |

运行创建于 `2026-10-11T10:41:58Z`；最后一条 accepted row 于约 `12:36:48Z` 完成，历时约 1 小时 54 分 50 秒。此期间完成 96/4,800 个任务行（2%）。

## 模型与工具调用 / Token

### DSH root / child

以下为 accepted rows 中有 `tokenUsage` 的记录求和；7 条失败记录没有 token usage，因此不是 96 条任务的总消耗上界，也不包含 bridge 未返回 usage 的失败生成。

| Arm | 有 token 记录 | Root input / output / total | Child input / output / total | 子会话归因 |
|---|---:|---:|---:|---|
| Single-agent | 47/48 | 1,115,077 / 9,584 / 1,124,661 | 0 / 0 / 0 | 完整归因 47 条 |
| Integrated | 42/48 | 1,319,478 / 13,178 / 1,332,656 | 508,056 / 4,402 / 512,458 | 20/20 个已观察子会话均归因；42 条记录的归因标记完整 |
| 合计 | 89/96 | 2,434,555 / 22,762 / 2,457,317 | 508,056 / 4,402 / 512,458 | DSH tree 合计 2,969,775 tokens |

运行日志统计到 131 次模拟 patient-agent assistant exchange 和 35 次合成患者追问；这不是 provider HTTP generation 的精确请求数。accepted rows 中共 10 个已完成工具事件：`consult_clinical_team` 5、`search_medical_evidence` 4、`recall_patient_memory` 1。Integrated 记录 20 个 child sessions，child failure 记录为 0。

### AMA 与 RAG

| 子系统 | 记录到的活动 | Token / 耗时 | 解释限制 |
|---|---|---|---|
| AMA | 169 条 memory trace：automatic recall 14 completed/59 skipped；commit 20 completed/3 failed/61 skipped；session_end 9 completed/1 failed/1 skipped；manual recall 1 completed | 99 次成功 usage-report 对应模型调用；2,218,651 prompt + 12,723 completion tokens。20 次 completed commit 的 P50/P95 延迟 17.63/19.85 s；3 次失败 commit 各约 90 s | trace 同时含重试、跳过、会话收尾和批量提交；不能准确分摊到 96 个 turn。单次 commit 可包含多次 AMA 调用。失败操作未提供 token usage |
| i-MedRAG | 4 个 integrated T07 轮次有 retrieval telemetry；每轮 2 rounds、4 retrieval calls、2 planner calls，3 条返回 evidence；`degraded=false` | 共 16 retrieval calls、8 planner calls；planner 138,222 input / 556 output tokens；检索+规划累计 43.684 s | 每轮 `uniqueDocuments` 合计 32（未跨轮去重）；只有 4/42 个 completed integrated turns 记录到非空 RAG telemetry。不能外推到其他轮次 |

RAG planner token/latency 已按 Health Engine telemetry 统计；它与 DSH tree、AMA 分开记录，不要把三类 token 直接当成模型账单值相加。当前数据支持“部分轮次跑通了 RAG/AMA/协作”，不支持“全量端到端完成”。

## 资源与服务状态

- 首次因运行保护停机时：`resource-stop.json` 记录可用 RAM 7.89 GiB，低于 8 GiB 阈值，累计 45 条记录。该文件保留不变。
- 本报告采样时（评测进程已停）：系统 RAM 总量约 63.75 GiB、可用约 31.33 GiB；RTX 4090 Laptop GPU 显存总量 16,376 MiB、已用约 4,231 MiB，GPU 利用率约 10%。这不是长跑期间的峰值，也不能归因于本评测。
- 磁盘可用空间约：C: 7.74 GiB、D: 179.74 GiB、E: 122.64 GiB。评测运行目录在 D:，C: 剩余空间相对紧张。
- 停止评测时只中断 evaluator；没有停止共享服务。随后 bridge `/healthz` 返回 `ok`、模型 `gpt-6-luna`、`activeTurns=0`、`queuedTurns=0`、`rpcTimeoutMs=240000`、最大并发 2。Health Engine 进程仍在运行；本次审计对其使用的 `/healthz` 路径返回 404，不能据此宣称该路径健康。
- 原 manifest 的 `hardware=null`。本次机器读数是停机后一次快照，未回填成运行期峰值。

## 审核与评分状态

- 96/96 行 `clinicalReviewStatus=pending`；`clinicalApprovalArtifact=null`。
- `review-packets.jsonl` 仅有换行符，0 条 packet；此 run 没有 review key/template 私有目录，也没有 `score-report.json`。
- 不存在真实临床审核记录或可解锁临床分数的审批材料。
- 因此复诊材料完成率、历史事实正确引用率、医学证据支持率、风险识别率、跨患者串扰率等临床效果指标当前全部 **blocked / not scored**。本地已有的 engineering run 不能替代临床人员对合成病例的审核及盲评。

## 暂停、可恢复性与下一步

本地 run manifest 已在保留原始 `sourceFingerprint`、`failedAt` 和 RAM guard `error` 的同时标记为 `paused`，清除失效 evaluator PID，并写入 96 条 durable row 的暂停快照。暂停边界为 HCE-0006 integrated T08 完成、HCE-0007 开始前。`runs.jsonl`、`attempt-history.jsonl`、`draft-bundles.jsonl`、`memory-trace.jsonl` 与 RAM guard 文件都保留。

**不要通过手工把 manifest 指纹改成当前值来续跑。** 当前源码指纹不匹配，且 cohort 的临床审核仍 pending。将此运行保留为诊断证据；M1/M2 完成后生成新 run ID，复用冻结 cohort 及配对任务定义，先跑两例工程回归，再依据审核结果扩到 30 例 development。不要在这次审计后直接启动 4,800 轮。

## 方法与边界

审计通过只读解析 manifest、`runs.jsonl`、`attempt-history.jsonl`、`memory-trace.jsonl`、`draft-bundles.jsonl`、`review-packets.jsonl` 及本机资源快照完成；未读取患者/助手对话正文、未启动模型请求、未下载模型/数据、未运行测试，也未生成临床评分。Token 汇总以每行和 memory trace 已保存的 usage 字段为准；telemetry 缺失表示未知，不能按零成本或零失败处理。
