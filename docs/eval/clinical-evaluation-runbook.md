# 临床复诊合成评测操作手册

本手册覆盖本机工程评测。评测数据必须是明确标记的合成资料；不能连接真实 EMR，也不能把报告解释成临床有效性、诊疗安全性或生产访问控制证明。

## 当前实现与限制

- Cohort 生成器可创建 300 个合成纵向档案、每档案 8 个评测任务（计划共 2,400 个任务），并分成 30 development、75 validation、195 held-out。新生成的 v2 cohort 另带确定性的患者披露状态机；`clinicalReviewStatus` 初始均为 `pending`，没有临床审核前任何临床评分都保持隐藏。
- A 组为无外部 RAG、AMA 长期记忆和专科协作的 DSH 单 Agent 基线；B 组在同一所选模型上启用本地 Health Engine RAG/AMA 与受限协作。默认 `scripted` 模式仍使用原固定消息以便复现旧协议。显式 `--patient-simulation=adaptive` 时，模拟患者先给简短开场，随后只按 Agent 的提问意图从当前评测任务允许的合成事实中披露信息；最多追加 3 条患者回复。规则匹配和回复不调用额外模型，且 run 会保存逐条对话 transcript、披露事实 ID 和识别到的提问意图。它是确定性规则模拟，不是自然人行为模型，也不证明临床真实性。
- 统一人工评分由盲化 A/B packet 记录。packet 不含真实组别、Run ID 或解盲 key；个别模型输出可能提及工具/协作，因此盲法不是绝对保证。packet 可以带最多 500 字的 evidence excerpt，供审核断言与引用；原始文献全文不进入运行记录。解盲文件只能保存在忽略提交的 `artifacts/clinical-eval/private/<studyRunId>/`。
- 本地隔离探针只验证两个随机合成 AMA namespace 的记忆召回边界；不验证患者/Encounter 授权、Gateway 身份校验、角色权限、租户隔离或生产存储。`pass` 只针对该探针声明的范围。
- 令牌统计记录 DSH root/direct-subagent 会话事件、逐轮 AMA，以及新版本中 Gateway 实际观察到的 RAG planner 用量；子 Agent 内未由 root observer 发出的 RAG 调用仍不计入。货币成本未归因。并发与延迟只代表 manifest 中的本机硬件和配置。

## 1. 生成并冻结合成 Cohort

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- generate --count=300 --seed=20261010 --development=30 --validation=75
pnpm --filter @huiyi/demo-gateway clinical-eval -- validate
```

核对输出中的数量、split、SHA-256 和 `allPendingReview`。旧 v1/scripted cohort 已验证为 300 例、2,400 轮、2,425 facts，split 为 30/75/195，SHA-256=`6e2d5b40bcf70026f2236e1a7730847368410ab263b7eefe72cc71fe28aab4ee`，全部 `clinicalReviewStatus=pending`。该文件位于被 Git 忽略的 `artifacts/clinical-eval/cohort-300.jsonl`；对应审核模板 `cohort-300.jsonl.approval.json` 仍为 `pending`，没有 reviewer identity 或批准病例。复评必须沿用完全相同的文件 hash；改病例即为新版本，应记录新的 hash 和审核。

上面 `cohort-300.jsonl` 是旧 v1/scripted 版本。当前 adaptive 评测另有 v2 冻结文件 `artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl`：300 例、2,400 个任务、2,425 facts，split=30/75/195，SHA-256=`7d70893f2ffab9f8711f5ac260a1f70729bef758fb41f7cae50afaa894a6310c`；其审批模板 `cohort-300-adaptive-v2.jsonl.approval.json` 已生成，但仍是 `pending`、无临床 reviewer/批准病例。v1/v2 hash 不可互换，也不能把不同患者模拟协议拼成一个配对结果。本次只生成与校验本地合成文本，没有调用模型。

对 cohort 做结构覆盖核查时，可输出不含患者 ID、姓名、canary 或病历文本的聚合摘要：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- validate --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --output=artifacts/clinical-eval/cohort-300-adaptive-v2.coverage.json
```

`coverage` 汇总 split、场景族、复杂度、预期任务、风险信号轮次、历史事实依赖轮次及审核状态；输出文件位于 Git 忽略的本地 artifacts。2026-10-11 核验结果：300 例/2,400 轮/2,425 facts；development 为 30 例、240 轮、243 facts（14 basic / 16 complex，覆盖 12 个场景族），validation 为 75 例/600 轮，held-out 为 195 例/1,560 轮；300 例仍全部 pending review。聚合文件不匹配任何 cohort patient ID、display name 或 isolation canary。此项只证明数据结构/覆盖，不代表 30 例模型评测已运行或任何临床任务已完成。

阶段 A 需要人工查看 development 档案及确定性 disclosure plan。为审核者导出单独的本地 packet：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- review-packet --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --split=development --limit=30 --output=artifacts/clinical-eval/reviews/development-v2-review-packet.json
```

packet 包含 30 例的合成 profile、事实目录、8 轮任务和逐轮披露规则，以及待填写的内容一致性、用药/过敏、风险信号和 disclosure checklist；病例、Encounter、事实和轮次 ID 都映射成 `REV-*` 审核别名，刻意不含内部 patient ID、cohort case ID、隔离 canary 或原始 FHIR bundle。仅把 `reviews/` 下的 packet 交给审核者；对应的真实 case ID crosswalk 写入 Git 忽略的 `artifacts/clinical-eval/private/cohort-reviews/`，不得分享。只有持证临床审核者真实完成审查后，才把其审核身份/时间和批准病例写入同 cohort hash 的 approval 文件；工程人员不得代填或自我批准。

审核者返回已填写 packet 后，用本机私有 crosswalk 导入 approval。导入器会校验 cohort hash、packet 内容未被改写、所有 case checklist 均已填写；只有四项检查全为 pass 且 decision 为 `approve-for-engineering` 的档案才进入批准列表，`revise` 档案必须填写修正说明。输出需指定一个新的 ignored 文件，避免覆盖待审模板：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- approve-packet --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --packet=artifacts/clinical-eval/reviews/development-v2-review-packet.json --crosswalk=artifacts/clinical-eval/private/cohort-reviews/7d70893f2ffab9f8-development.json --output=artifacts/clinical-eval/approvals/development-v2-approved.json
```

导入只接受 packet 自填的 reviewer ID、`licensed-clinician` 角色和时间戳；它们仍是本地自我声明，工具不验证执照或机构身份。审批只解锁被批准档案的工程评分资格，不等同临床有效性；blind packet adjudication 仍是另一道门。

## 2. 小样本联通与配对比较

当前 Windows 本机 Codex 路线使用已登录的 Codex CLI，通过 `codex app-server` JSON-RPC 给 GPT-6-Luna 提供本地 loopback Chat Completions bridge。它不需要 OpenAI Platform API key；app-server 请求受本机 Codex/ChatGPT 计划用量约束。bridge 每次 DSH 模型生成都创建一个 ephemeral thread，要求结构化输出，最多返回一个 DSH function call；DSH 本身继续执行 AMA、RAG 和协作工具。仅把合成 cohort 内容发送给模型。

**必须同时配置两个生成入口。** Gateway/DSH 的 `HUIYI_DEMO_MODEL_BACKEND=codex-app-server` 只控制根 Agent 和 DSH 子 Agent；Health Engine 的 AMA 记忆算法另有 `HUIYI_LOCAL_LLM_BASE_URL` / `HUIYI_LOCAL_LLM_MODEL`。本机 8322–8324 是在不同环境中启动的既有进程；端口健康或 RAG ready 不证明其 AMA 路由指向 GPT-6-Luna。旧配置曾把 AMA 指向本地 `Qwen/Qwen3-8B`，因此任何未核对路由的 AMA E2E 都不能称为 GPT-6-Luna-only。

先在终端 1 启动 GPT-6-Luna bridge，再在终端 2 启动隔离的 Health Engine。`codex-bridge` 默认监听 8333，Health Engine 启动脚本的 `-BridgePort` 默认也是 8333；二者必须指向同一实例。已有服务要以 Health Engine 的 `/_internal/evaluation/config` 实际 attestation 为准：本次运行中的 8325 将 AMA 与 i-MedRAG planner 指向 8334，另一个已验证的 Luna bridge 在 8333。若复用 8334，启动脚本需显式传 `-BridgePort 8334`，评测进程需将 `HUIYI_CODEX_BRIDGE_URL` 设为 `http://127.0.0.1:8334/v1`。不要只依据端口号猜模型路由。启动脚本会单独放置合成记忆；召回前清空 AMA 短期窗口，避免跨 Encounter 的会话文本进入召回提示。Qwen3-Embedding-0.6B 只做 CPU 向量编码/检索，不生成文本。它使用 Qwen3 五源 FAISS manifest，默认监听 8325：

```powershell
pnpm --filter @huiyi/demo-gateway codex-bridge

# 另开终端；不调用模型，只检查 bridge/model 清单、索引路径和端口
$env:HUIYI_CODEX_BRIDGE_API_KEY = 'local-only'
.\scripts\eval\start-gpt6-health-engine.ps1 -CheckOnly

# 通过检查后启动隔离 Health Engine
.\scripts\eval\start-gpt6-health-engine.ps1
```

终端 3 的评测必须显式设置 `$env:HUIYI_HEALTH_ENGINE_URL='http://127.0.0.1:8325'`。不要复用其它 Health Engine 端口，除非已通过其 evaluation config 证明 AMA 和 RAG planner 都使用 `gpt-6-luna` 且 endpoint 与评测 bridge 一致。本地 Qwen3-8B 服务即使仍在运行，也不应成为 AMA、RAG planner 或 DSH 的生成后备路由。

在终端 1 启动 bridge：

```powershell
pnpm --filter @huiyi/demo-gateway codex-bridge
```

两项服务就绪后，先运行两轮 GPT-6-Luna 集成 smoke：首轮披露合成风险信号以检查临床协作，第二轮在同一 Encounter 查询医学证据以检查本地 RAG；同时核对认证 Gateway、AMA 召回/提交、Health Engine 路由证明和记忆清理。smoke 启动前会读取 bridge `/healthz`，要求模型与本地路由匹配且报告 `maxConcurrentTurns`（范围 1–4）及一致的活动/排队计数；运行期间继续采样，配置上限发生变化或观察器没有样本时将失败，产物会记录验证过的上限。评测模式在每个 Encounter 的首轮自动召回历史，后续轮次复用当前 DSH 会话并保留显式 `recall_patient_memory` 工具；这样既避免每轮重复扫描同一记忆，也保留医生/Agent 的按需查询。AMA 长期存储只写患者侧发言，不把助手生成内容当作患者病史。smoke 最多只运行两轮，不生成临床成绩：

```powershell
$env:HUIYI_CODEX_BRIDGE_API_KEY = 'local-only'
$env:HUIYI_CODEX_BRIDGE_URL = 'http://127.0.0.1:8333/v1' # 必须与 Health Engine attestation 中的 endpoint 一致
$env:HUIYI_HEALTH_ENGINE_URL = 'http://127.0.0.1:8325'
pnpm clinical:eval:smoke
```

smoke JSON 位于 `artifacts/clinical-eval/smokes/`，只存路由、工具、协作子运行摘要、证据数量、耗时和 token/AMA 计数；不存完整回答。失败时 `failureDiagnostics` 仅含筛选后的类别、provider error code 和可用 HTTP 状态；本地 Codex bridge stderr 仅含固定类别及受限的 JSON-RPC / turn 状态，不记录错误原文、模型输出、患者文本或请求 ID。smoke 会把 AMA 长期存储限定为患者侧输入，跳过空 namespace 的模型召回，并在完成后清理该合成身份的记忆。输出中的 `tokenAttribution` 会标记协作子运行有记录、但 DSH subagent token 未报告的情况。该 smoke 仍不替代多病例任务评测与盲审。

如需验证 **DSH 工具链确实发出 iterative 请求并收到 Luna planner 的结果**，使用单轮 evidence 专项 smoke。脚本会要求模型明确在工具参数中选择 `mode="iterative"`，采集实际请求/响应的结构化检索计数；没有记录原始问题、证据片段或模型回答。未观察到 iterative mode、Luna planner 调用或非降级结果时 smoke 会失败。下面的 8334 必须与当前 Health Engine attestation 相同；从头启动两项服务时可以用默认 8333：

```powershell
$env:HUIYI_CODEX_BRIDGE_API_KEY = 'local-only'
$env:HUIYI_CODEX_BRIDGE_URL = 'http://127.0.0.1:8334/v1'
$env:HUIYI_HEALTH_ENGINE_URL = 'http://127.0.0.1:8325'
$env:HUIYI_GPT6_SMOKE_FOCUS = 'evidence'
$env:HUIYI_GPT6_SMOKE_RAG_MODE = 'iterative'
$env:HUIYI_DEMO_MAX_TOKENS = '768'
pnpm clinical:eval:smoke
```

这是一个合成病例、一个 DSH evidence turn 的工具路由 smoke；不测协作、不计算临床成绩，也不强制覆盖模型实际传入的工具参数。输出中的 `ragExecutions` 保存有效检索 mode、planner/model、耗时与数量指标，不保留文本内容。

在终端 3 选择 Codex 后端并先运行一个 development 病例。临床评测 runner 已拒绝默认 vLLM/Qwen3-8B 后端，防止误把本地生成混入 Luna-only 结果：

```powershell
$env:HUIYI_DEMO_BACKEND = 'dsh'
$env:HUIYI_DEMO_MODEL_BACKEND = 'codex-app-server'
$env:HUIYI_CODEX_BRIDGE_API_KEY = 'local-only'
$env:HUIYI_HEALTH_ENGINE_URL = 'http://127.0.0.1:8325'
$env:HUIYI_DEMO_SYNTHETIC_AMA_MEMORY = '1'
pnpm clinical:eval -- run --split=development --case-ids=HCE-0007 --arms=integrated --synthetic-ama-memory=true --concurrency=1 --max-tokens=768 --memory-commit-batch-turns=4 --turn-timeout-ms=300000
```

要使用 v2 的自适应披露协议，在确认该新 cohort 已审核、审批并评估完 API/token 预算后，将运行命令加入 `--patient-simulation=adaptive`。开发 smoke 可再加 `--patient-followups=1`，把每个评测任务限制为最多两次根 Agent 调用（开场一次、最多一次跟进）；未设置时按 cohort 规则上限 3 次跟进。CLI 会将本次根 Agent 调用上限写入 manifest，续跑沿用原限制。默认 3 次跟进时，2,400 个任务的根 Agent 调用上限为 9,600（单臂；双臂 19,200），实际 DSH 子 Agent、AMA 和 RAG planner 调用还会增加请求总量；目前不启动这种批量运行。

集成臂默认将同一 Encounter 的 4 轮患者发言合并提交一次 AMA；`--memory-commit-batch-turns=1` 可冻结为逐轮写入。批次值写入 manifest，续跑时沿用原值，不能中途更改。

每个 run 会冻结 cohort hash、病例列表、A/B 臂、模型 provider/model/endpoint、Health Engine 地址、最大输出 token、并发与超时。若进程中断或某病例臂失败，使用 manifest 中的 run ID 继续；模型和数据不匹配时命令会拒绝继续：

```powershell
pnpm clinical:eval -- run --study-run-id=<manifest 中的 studyRunId> --resume=true
```

续跑按“病例 × 评测臂”恢复：只有该病例臂的所有预期轮次均为 completed 才会跳过；其余病例臂从第一轮重跑，避免把半截会话接到新 Gateway/DSH Session。旧的失败/中断记录保存在 `attempt-history.jsonl`，失败草稿保存在 `attempt-drafts.jsonl`，不进入最终评分；完整病例臂结果仍保留。运行参数沿用 manifest，续跑命令只允许额外指定相同的 `--cohort` 或原审批文件。最终 review packet 和报告从完整的 `runs.jsonl` 重建。若只需重建报告，可单独运行 `finalize`。

bridge 地址只能使用 loopback；默认是 `http://127.0.0.1:8333/v1`。`HUIYI_CODEX_BRIDGE_API_KEY` 两个终端必须相同。Codex app-server 以只读 sandbox 与 `approvalPolicy=never` 启动，提示其不调用 Codex 自带工具；如果无法启动本机 `codex app-server` 或当前登录不能调用 `gpt-6-luna`，运行会失败，不会回退到 Qwen。该适配是本地探索用的协议桥接，不是 DSH 的通用 OpenAI API provider，也不应用于生产部署。app-server 的 completion output token 上限目前由请求提示约束，不能保证等同于 DSH 的 `max_tokens` 硬上限。

评测 `run`/`resume` 现固定只允许 `HUIYI_DEMO_MODEL_BACKEND=codex-app-server` 和精确模型 `gpt-6-luna`；若环境为空而默认解析成本地 `Qwen/Qwen3-8B`，命令会在建 Gateway/DSH Session 和发出请求前拒绝。Qwen3-Embedding-0.6B 仍只作为本地向量编码器，不生成文本。

先用无生成调用的 `plan` 查看冻结选择规模。它报告患者任务轮数、adaptive 跟进上限和根 Agent 交互上限，不读取/输出病例内容，也不等价于 token 或费用估算；DSH 工具循环、子 Agent、AMA 与 RAG planner 会额外发起生成。对 integrated arm，`plan` 只读请求 loopback bridge `/healthz` 与 Health Engine `/health`、`/_internal/evaluation/config`，核验 AMA/planner 模型路由、RAG 开关、AMA recall 隔离和 Qwen3-Embedding-0.6B 标识；不会请求聊天生成或实际向量检索。实际运行开始时仍会再做 Health Engine 健康与本地检索 readiness 检查：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- plan --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --split=development --limit=1 --arms=both --patient-simulation=adaptive --patient-followups=1 --synthetic-ama-memory=true --output=artifacts/clinical-eval/plans/plan.json
```

计划输出只含聚合计数和路由标识。先确认 `matchesRequestedCodexLunaRoute=true`、`healthEngineRouteAttestation.status=matched`、`healthEngineRouteAttestation.bridgeBoundedConcurrency=true`、`bridgeMaxConcurrentTurns` 为 1–4、`preflightBlockers=[]`。不报告这些字段的旧 bridge 会被判为 mismatch；需在空闲端口启动当前 worktree 的 bridge，再重跑 plan。另看 `clinicalMetricGate.selectedCasesApproved`：即便为 true，临床指标仍需盲审 adjudication 后才能解锁；若为 false，不要把后续工程运行解释成临床成绩。

Route attestation 还会校验 Codex bridge 的 `/healthz` 模型、路由、1–4 并发上限及活动/排队计数器，并比对 Health Engine 与 pinned AMA Python 源码指纹，避免模型配置正确但运行进程仍加载旧代码。通过后，`manifest.healthEngineRoute.bridgeMaxConcurrentTurns` 会冻结该次运行所用的 bridge 上限，续跑时也会比较 attestation。若 bridge 字段缺失或 Health Engine 指纹不匹配，先在空闲端口启动当前代码，再重新运行 plan；不要覆盖正在使用的服务。

随后从 development split 选 1 个病例做单 Agent smoke：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- run --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --split=development --case-ids=HCE-0001 --arms=single-agent --patient-simulation=adaptive --patient-followups=1 --max-tokens=1536
```

检查每轮是否完成、RAG/协作工具是否实际调用、协作是否降级、manifest 的 Health Engine route attestation 是否同时显示 AMA 与 planner 为 GPT-6-Luna，以及 `runs.jsonl` 中 `memoryUsage` 的逐轮调用/token 统计和会话清理状态。`memory-trace.jsonl` 只存结构化元数据，不写入提示或模型文本。集成臂每轮先等 AMA 异步记忆提交完成，再进入下一轮。若 `runs.jsonl` 只显示 turn completed、但工具调用/证据/协作为 0，不算集成组通过。之后对同一个病例跑配对两组；B 组会写入仅供该 run 使用的随机合成 AMA namespace，并在每个病例结束时清理：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- run --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --split=development --case-ids=HCE-0001 --arms=both --synthetic-ama-memory=true --patient-simulation=adaptive --patient-followups=1 --concurrency=1 --max-tokens=1536
```

跑全 30 development 前，先观察一次集成病例的 AMA commit/recall 耗时，确认本机能承受预计运行时间。不要因为 Cohort 已有 300 条就直接启动 2,400 轮；评测 PRD 规定先完成 30、再冻结范围跑 60–80、最后才考虑约 300 人独立测试。

截至 2026-10-11，300 例 cohort 的校验结果为 2,400 个计划轮次，全部 `clinicalReviewStatus=pending`，所以临床任务、证据支持和风险指标仍必须隐藏。旧版 bridge 配置的一例 16 轮 DSH smoke 虽然 16/16 turn completed，但实际 tool/evidence/collaboration 均为 0，且 AMA 内部计数显示使用了非 GPT-6-Luna 路由；该运行仅作故障诊断，不能并入 GPT-6-Luna 指标或简历数字。更早的单独合成 RAG smoke 检索到 3 条来源；自然语言复杂协作 smoke 完成 8 个 MDAgents-derived 子运行、0 失败、未降级、端到端约 150 秒。这些都只是链路 smoke，不是经审核的临床成绩。2026-10-11 的认证 Gateway 两轮 Luna smoke `smoke-20261010194859-17bfb115` 已通过：HCE-0001 的 T06/T07 均完成；风险轮触发协作，证据轮调用本地 RAG 并返回 3 条来源，检索耗时 298 ms；两轮 AMA commit 均成功，共 8 次调用、178,870 prompt / 867 completion tokens，记忆清理通过；总耗时 151.048 秒。DSH 记录 76,961 input / 506 output tokens，但子 Agent token 归因仍未核完整，不能把它当作完整 Agent Tree 用量。该运行证明认证 Gateway、DSH、AMA 和本地 RAG 的合成链路可用，不证明历史病史跨 Encounter 召回或临床效果。

随后完成一次 GPT-6-Luna 配对诊断运行 `20261010195524-02c45664`：HCE-0001 共 8 个脚本化轮次，single-agent 与 integrated 两臂各 8/8 DSH turn completed，总计 16/16，耗时 457 秒。集成臂实际调用 `consult_clinical_team` 2 次、`search_medical_evidence` 1 次并返回 3 条证据；执行中位数 31.93 秒、P95 114.68 秒，单 Agent 中位数 5.69 秒、P95 9.69 秒。**但集成臂 8/8 AMA commit 均失败，错误类别为 `OperationalError`**；Health Engine 记录的 32 次 AMA 模型阶段生成虽全部完成（710,667 prompt / 2,791 completion tokens），记忆没有成功写入，因此这次运行不能作为 AMA 长期记忆或跨轮召回结果。DSH subagent token 仍显示为 0，Agent Tree 用量不完整；跨患者记忆隔离探针未运行，临床审核为 0/16，所有临床指标仍为 `null`。产物在 `artifacts/clinical-eval/runs/20261010195524-02c45664/`。下一步先定位并修复 AMA `OperationalError`，然后只用一个合成病例验证写入、后续 Encounter 召回及清理；这些关口通过前不扩至 30 例。

此前两次连续 smoke 尝试分别暴露了过严的协作断言和一次 DSH 通用 `MODEL_FAILURE`。Luna bridge 已加仅针对 app-server `failed` 状态的一次有界重试；当前通过的 smoke 未能确认重试分支是否触发。300 例临床评测仍需分阶段执行，并先补齐子 Agent token 归因和人工审核。

2026-10-11 AMA 修复后的 GPT-6-Luna 集成复跑 `20261010215448-3bdd5077`：HCE-0001 的 8/8 DSH turns 全部完成；两次 `consult_clinical_team` 共完成 7 个子运行、0 失败、未降级；T07 的本地 RAG 调用返回 3 条证据，单次检索约 310 ms。两段 Encounter 各成功提交一次 AMA 批次，首次进入第二段时召回 8 个记忆项；全程 AMA 共 10 次模型调用（217,947 prompt / 1,381 completion tokens）。同一单例旧诊断运行记录 34 次 AMA 调用（778,187 / 4,389 tokens）；这是单例工程对比，并非受控临床效果实验。每段 Encounter 的 4 轮患者发言合并提交，运行清单冻结 `memoryCommitBatchTurns=4`；该参数仅在显式合成临床评测模式生效，可用 `--memory-commit-batch-turns=1` 恢复逐轮写入。8 轮 DSH 时延中位数 19.85 秒、P95 128.5 秒，仅代表此单例。患者 namespace 清理后复核为 0 memory-window items / 0 raw / 0 facts / 0 episodes；临床审核仍为 0/8，临床评分仍隐藏，DSH 子 Agent token 归因仍未补齐。产物约 106 KB，没有下载模型或语料。

同一 run 上的本地 AMA namespace 隔离探针 `isolation-probes.jsonl` 为 `pass`：两侧 canary 各自可召回，未发现跨侧泄漏，双方清理均验证通过。其范围仅是本地 Health Engine 的合成 AMA namespace，不代表 Gateway 身份授权、租户/角色隔离或生产安全验收。进入 30 development 阶段前，已通过单例的双 Encounter AMA 写入、后续 Encounter 召回、RAG、协作及 namespace 清理；仍需补齐 DSH 子 Agent token 归因，并按本机用量预算分批运行和保留中断续跑。不要直接启动 2,400 轮；先 30、再冻结范围跑 60–80、最后才考虑约 300 人独立测试。每次评测前核对磁盘/RAM 和服务端点，不触发模型或语料下载。

随后对 token 观察器做了共享 DSH Context 修复，并用两轮 GPT-6-Luna smoke `smoke-20261010220530-5f799cf6` 实测：单个协作 child run 报告了 18,368 个子 Agent tokens；同一 smoke 的本地 RAG 返回 3 条证据，AMA 两次提交共 9 次调用，记忆清理通过，总耗时约 90.5 秒。该样本确认子 Session usage 事件能到达 observer。运行记录旧格式只以“存在子 token”推断归因完整；其后的代码改成记录唯一子 Session 数，并要求其与 collaboration child run 数相等才标记完整。计数逻辑通过定向单元测试；新格式也在下方 5-child 尝试中通过了精确数量核对，但由于 root 最终回答失败，该次不能作为完整 E2E 通过。

随后 safety-only 新计数 smoke `smoke-20261010220935-f772517a` 实际完成 5 个 collaboration child runs，observer 精确计到 5 个不同子 Session、101,500 subagent tokens，`subagentAttributionComplete=true`；但 root 在协作工具返回后以 `MODEL_FAILURE` 结束，AMA 未提交，清理通过，因此整轮仍判失败。另一次 768-token safety-only 尝试 `smoke-20261010221205-d2d34b3e` 在 20.3 秒以 `MODEL_FAILURE` 结束，未触发工具。2026-10-11 的单轮 384-token 诊断 smoke `smoke-20261010221703-07607a5c` 也在约 20.4 秒、调用协作前失败；安全终止元数据将错误细化为 provider code `SERVER`，无 HTTP 状态，AMA 清理通过。该次先遇到 smoke 默认 8333 与运行中 Health Engine attestation 的 8334 不一致，显式对齐 URL 后才进入模型调用。仍没有依据定位 Codex app-server 内部的具体错误，不得把失败包装成通过或归因于 token 上限。

本地 Codex bridge 已增加脱敏 stderr 诊断，并在 OpenAI-compatible 502 响应中返回相同的白名单字段：固定故障类别、受限的 app-server turn status/RPC method/RPC code/system error code；不返回原始错误消息、模型输出、患者文本或请求 ID。此逻辑须在该版本 bridge 启动后生效。单轮通过仍需结合重复性、每例调用成本及人工盲审结果，才能决定是否扩大 cohort。

2026-10-11 自适应 v2 诊断运行 `20261011004712-ff4edb78` 记录 16 条：single-agent 8/8 完成，integrated 0/8 完成、8/8 `MODEL_FAILURE`。首个集成任务触发 6 个协作 child runs，其中 1 个失败、结果降级；观察到 5/6 子 Session，且执行了本地 RAG。随后 integrated-only 诊断运行 `20261011005647-b1664d09` 的 8/8 任务仍以 `MODEL_FAILURE` 失败；新增的安全字段均为 `category=provider`、`providerErrorCode=SERVER`，每轮约 20 秒，没有可归因的 DSH token usage。两次均为 partial engineering diagnostics，不计临床任务成功率、证据支持率或模型稳定率。

为定位失败是否来自旧 bridge/app-server 进程，未重启正在使用的 8333/8334 服务，而是在空闲 loopback 端口 8335 启动隔离的新 bridge，并只发送一条不含病例资料的 `max_tokens=8` 最小请求。GPT-6-Luna app-server 返回 HTTP 200、`finish_reason=stop`；用量统计为 16,986 total tokens。该桥接配置把输出上限写入提示，并不保证它是 app-server 的硬上限；本次观测说明即使极短请求也有明显上下文成本，因此没有继续请求或扩大批次。测试后临时 bridge 已停止，8335 无监听，原 8333/8334 实例未修改。运行前后 C/D/E 空余空间维持 8.6/179.6/131.3 GiB，空闲 RAM 约 8.2→8.3/63.7 GiB，4090 显存维持 11,795/16,376 MiB；没有下载模型、语料或依赖。新实例通过不代表旧实例或 DSH→Health Engine 临床链路已修复；下一步若重试，先为现有服务安排受控重启和一次单轮 smoke，再依据实际 token 成本决定是否继续。

随后确认 8333/8334 没有活动连接后，滚动了两个空闲 bridge 进程，没有重启 Gateway 或 Health Engine。`clinical-eval:smoke` 首次预检因默认 bridge `8333` 与 Health Engine attestation `8334` 不一致而退出，未发送生成请求；显式对齐 `HUIYI_CODEX_BRIDGE_URL=http://127.0.0.1:8334/v1` 后，单独的 synthetic evidence smoke `smoke-20261011010905-a3590b18` 通过。HCE-0001 T07 经认证 Gateway/DSH 调用 `search_medical_evidence`，`run.completed`，返回 3 条 StatPearls evidence；single RAG 1 次检索、0 次 planner、270.4 ms，无降级。Health Engine attestation 为 AMA/planner=`gpt-6-luna`、embedding=`Qwen3-Embedding-0.6B`。DSH root 37,404 input / 240 output tokens；AMA 两项操作、4 次模型调用、0 失败，清理核验通过；运行耗时 27.573 秒。终端的 AMA usage telemetry 记录 89,063 prompt / 325 completion tokens（smoke JSON 只保留 AMA 调用计数，不含这两个 token 汇总）。运行产物 [`smoke-20261011010905-a3590b18.json`](../../artifacts/clinical-eval/smokes/smoke-20261011010905-a3590b18.json) SHA-256=`33E87C4FE52DA9B7BE939E7B3C8C53FF844386B54F2F5CE582062E77F852601A`。这是一个 evidence-only 单轮 smoke，没有触发协作或 iterative planner，也没有临床评分；不能据此填证据支持率或任务完成率。运行前后磁盘可用空间均为 C/D/E=`8.6/179.6/131.3 GiB`，空闲 RAM `16.4→16.1 GiB`；没有下载模型、语料或依赖。

随后重跑 safety-only T06 得到 [`smoke-20261011011022-de9b3771.json`](../../artifacts/clinical-eval/smokes/smoke-20261011011022-de9b3771.json)：DSH `run.completed`，协作 5/5 子任务完成、0 失败、未降级，token observer 记录 5/5 子 Session 和 139,460 child tokens；AMA 提交成功，4 次调用、清理通过。协作主机侧另有一次 RAG 检索，返回 3 条 Textbooks/StatPearls evidence，但 Gateway 父会话没有该 RAG telemetry，smoke 因 `GATEWAY_RAG_TELEMETRY_COUNT_MISMATCH` 判为 `failed`。运行总耗时 143.272 秒，DSH Agent Tree 177,385 tokens，AMA 88,948 prompt / 383 completion tokens。此旧产物保留为失败，不将子任务完成包装成整轮通过。

为补齐这条可观测性缺口，协作工具结果及 `collaboration.completed` 现在携带白名单 RAG counters/corpus 版本；不携带 query、证据正文或患者文本，smoke 核对器也会将其与直接 `evidence.completed` telemetry 合并对账。修改后复跑 [`smoke-20261011011633-28ebdd4a.json`](../../artifacts/clinical-eval/smokes/smoke-20261011011633-28ebdd4a.json)，状态 `passed`，HCE-0001 T06 `run.completed`；Gateway RAG telemetry 与一次协作上下文检索 1/1 对齐，返回 3 条 Textbooks/StatPearls evidence，single mode、310.2 ms、0 planner、未降级。协作完成 1/1 子运行、0 失败、未降级，但该次分类为 `basic`；child tokens 28,144、DSH Agent Tree 65,412 tokens。AMA 4 次调用、88,948 prompt / 392 completion tokens、0 失败，清理通过；总耗时 46.104 秒。产物 SHA-256=`F1B193223D91E2653511CFCFC53D14C1952B305CF305BAAE2744EA2914D3FF41`。该 smoke 证明 metadata 对账修复和一例合成工作流的工程路径；它不是复杂病例成绩、引用支持率或临床效果。运行后 RAM 可用 15.7 GiB，C/D/E 空余仍为 8.6/179.6/131.3 GiB，GPU 使用 11,795/16,376 MiB；GPT 调用走 Codex app-server，未在 4090 上运行生成模型，无模型、语料或依赖下载。

bridge 重启并显式将 smoke URL 对齐到 `http://127.0.0.1:8334/v1` 后，安全协作单轮 smoke `smoke-20261010222030-1a2b1d4e` 通过：HCE-0001 T06 root completed，临床协作完成 6/6 child runs、0 失败且未降级；token 观察器精确匹配 6/6 子 Session，DSH Agent Tree 共 189,878 tokens（root 38,566；children 151,312）。该轮总耗时 123.067 秒；AMA 两个操作合计 4 次调用，提交成功，合成记忆清理通过。它是一个复杂风险轮的链路与归因 smoke，不能抵消此前失败样本，也不代表临床任务完成率或稳定性。单轮 token 成本偏高；先用本机预算规划小批次，病例未盲审前不发布临床效果分数。

随后以当前 token observer、批次记忆配置和五源 Qwen3 索引完成 Luna-only 集成运行 `20261010224231-d65354a1`：HCE-0001 的 8/8 轮完成、0 失败；两次 Encounter 分别完成一次 AMA commit，第二个 Encounter 的自动 recall 返回 9 个记忆项；AMA 共 10 次模型调用（218,226 prompt / 1,444 completion tokens），0 个记忆操作失败。协作工具调用 2 次，共 6/6 子运行成功、未降级；DSH Agent Tree 用量完整覆盖 8/8 轮，根 Agent 与直接子 Agent 合计 333,735 input / 3,406 output tokens，其中子 Agent 120,565 tokens。一次 single-mode 本地 RAG 检索返回 3 条 evidence，耗时 302 ms，`plannerCalls=0`，因此这次运行没有验证 iterative i-MedRAG planner。8 轮 DSH 时延中位数 18.13 秒、P95 74.59 秒，仅为本机单病例指标。报告将临床指标标为 `blocked-unreviewed-cohort`（0/8 adjudicated），AMA namespace isolation 标为 `not-run`；运行 trace 没有独立的清理后计数，不能把成功执行的 forget 调用扩大成“记忆清理已独立复核”。运行产物位于 `artifacts/clinical-eval/runs/20261010224231-d65354a1/`。该运行补齐了多轮 Agent Tree token 归因，但不构成临床任务成绩、证据支持率或稳定性结论。

随后通过 `scripts/eval/rag-iterative-smoke.ps1` 对本机 Health Engine 直接执行一次通用问题的 iterative RAG 检索（不发起回答生成，也不使用患者资料）。结果保存在忽略提交的 `artifacts/clinical-eval/rag-smokes/rag-iterative-20261011-064955.json`：GPT-6-Luna planner 两轮生成 4 个查询、执行 4 次检索，候选 12、去重文档 8、返回 evidence 3；检索 1,065.9 ms，规划 8,152.2 ms，总计 9,218.3 ms，planner 使用 34,910 input / 101 output tokens，未降级。五源 Qwen3-Embedding-0.6B 索引报告 823,450 chunks，实际结果来源为 PubMed 与 StatPearls。运行前后 C/D/E 可用空间均为 8.8/179.7/131.3 GiB，RAM 可用均为 11.3/63.7 GiB，4090 Laptop 显存均为 11,795/16,376 MiB（GPU 利用率 12%→13%）；本次没有下载模型、语料或依赖。这个结果验证的是独立检索规划与召回链路，不代表 DSH 在临床会话中调用 iterative 模式，也不评价证据支持率、临床准确性或答案质量。后续运行前继续检查磁盘和内存；不要因此直接扩大到 30 例。

脚本现支持 `english`、`chinese`、`bilingual` 三种固定查询 profile；`bilingual` 顺序执行一条英文和一条简体中文通用问题，只保存语言标识、query hash/长度、检索计数、模型 token 和资源快照，不保存 query/检索证据正文/回答：

```powershell
.\scripts\eval\rag-iterative-smoke.ps1 -Profile bilingual
```

本机英/简体中文 smoke 产物：`rag-iterative-20261011-070232.json` 的英文项通过，Luna planner 2 轮/4 个 query，4 次检索，12 个候选、8 篇去重文献、3 条返回 evidence；规划/检索总耗时 8,099.5 ms，34,910 input / 102 output tokens，命中 StatPearls 与 PubMed。该文件中的中文首轮曾降级为 single，3 条 PubMed evidence 只是 fallback，不计 iterative 通过。随后对相同 SHA-256 的中文问题单独调用新版 `QueryPlanner`，产出 2 个规划查询（3,962.9 ms、17,131 / 73 tokens，`planner-class-probe-20261011-070324.json`）；紧接着完整中文 iterative 检索 `rag-iterative-20261011-070402.json` 通过：2 轮/4 个 query、4 次检索，12 个候选、9 篇去重文献、3 条证据，规划/检索总耗时 11,561.6 ms，34,833 / 139 planner tokens，来源为 PubMed。由于相同中文输入随后通过，最初的 `PlannerError` 目前是不可复现的瞬时失败，不能归因于中文能力；其底层失败类别仍未从当时未更新的 8325 进程中取回。两种语言各有一次完整链路成功，不构成稳定率或证据相关性/支持率结论。中文单独运行前后 RAM 10.7→10.6 GiB，磁盘 C/D/E 均保持 8.8/179.7/131.3 GiB，GPU 显存 11,795 MiB；未下载模型、语料或依赖。

随后使用上文的单轮 evidence 专项配置验证 DSH→Health Engine iterative 路径。第一次 smoke `smoke-20261010225500-4be57aed` 虽由模型向工具传入 `mode="iterative"`，planner 当次报错并降级为 single，因此判定为失败。为让路径测量可复现，第二次改用固定通用问题；`smoke-20261010225725-8c69f5d9` 通过：HCE-0001 合成会话实际请求和响应均为 iterative，GPT-6-Luna planner 两轮、4 个查询、4 次检索，候选 12、去重文档 6、返回证据 3；检索 1,119.7 ms、规划 8,359.3 ms、总计 9,479.2 ms，planner 34,852 input / 132 output tokens，无降级。DSH root 用量 37,977 input / 488 output tokens；AMA 4 次调用、89,090 / 822 tokens，清理后验证通过。这个一病例一轮结果只证明被提示时 DSH 会把 iterative mode 传给工具、且该次 planner 成功；前一次失败仍保留，不把两次尝试解释成稳定性比例。运行后 RAM 可用 10.8 GiB，C/D/E 空余仍为 8.8/179.7/131.3 GiB，GPU 显存占用 11,795 MiB。没有下载模型、语料或依赖。

该失败样本只记录通用 `PlannerError`，无法定位 provider HTTP、超时或结构化计划解析故障。我已在 Health Engine 源码中增加不含原始错误正文的安全 failure-class 分类，并将回退结果保留为具体类别；`services/health-engine/tests/test_rag.py` 定向测试 12 项通过。当前 8325 服务在该代码改动前启动，下一次重启后才会启用新诊断；没有为此重启正在运行的服务。

本轮另行只读验证 cohort 后生成了审核模板：cohort hash 仍为 `6e2d5b40bcf70026f2236e1a7730847368410ab263b7eefe72cc71fe28aab4ee`，模板输出为 `artifacts/clinical-eval/cohort-300.jsonl.approval.json`，状态 `pending`，要求 `licensed-clinician` 审核。该文件只准备审核流程，不能由工程运行替代临床审核；在有 reviewer 依法审批前，不运行 30 例临床成绩批次，也不解锁任何临床指标。

## 3. 运行 AMA namespace 隔离探针

探针写入两段随机合成 canary 到两个 run-scoped memory identity，交叉查询后立即分别执行忘记与计数核验。命令需要显式 `--synthetic-only=true`：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- isolation-probe --synthetic-only=true --run-dir=artifacts/clinical-eval/runs/<studyRunId>
```

只有 A/B 两侧都能召回自己的 canary、互相未召回、并且清理后两侧记录数均为 0，探针才记为 `pass`。没有自召回、运行异常或清理失败会记成 `indeterminate`；发现跨侧 canary 则记 `fail`。报告不包含 canary 或患者/namespace 标识。探针失败或清理状态不明时先调查并确认存储状态，不要继续批量写入。

## 4. 合成 Gateway 授权矩阵（不调用模型）

在临床评测 Gateway 使用两个同租户、不同 access group 的临时合成账号运行 `scripts/eval/authz-sweep.ps1`。脚本只请求登录、患者上下文、会话创建/关闭和退出接口，不调用 DSH、AMA、RAG 或 GPT-6-Luna；它拒绝非 loopback Gateway，并要求 `/api/health` 明确报告 DSH + Codex app-server + GPT-6-Luna。账号密码只从当前 PowerShell 进程环境变量读取，报告不保留账号名、密码、患者明细或响应正文。

```powershell
$env:HUIYI_AUTHZ_SWEEP_USER_A = 'eval-sweep-a'
$env:HUIYI_AUTHZ_SWEEP_PASSWORD_A = '<至少 12 位的一次性本机密码>'
$env:HUIYI_AUTHZ_SWEEP_USER_B = 'eval-sweep-b'
$env:HUIYI_AUTHZ_SWEEP_PASSWORD_B = '<至少 12 位的一次性本机密码>'
.\scripts\eval\authz-sweep.ps1 -PatientCount 300 -EncounterCount 3 -BaseUrl 'http://127.0.0.1:8321' -Origin 'http://127.0.0.1:5173'
Remove-Item Env:HUIYI_AUTHZ_SWEEP_USER_A,Env:HUIYI_AUTHZ_SWEEP_PASSWORD_A,Env:HUIYI_AUTHZ_SWEEP_USER_B,Env:HUIYI_AUTHZ_SWEEP_PASSWORD_B
```

账号名必须与 Gateway 启动时配置一致；A/B 账号应属于同一 tenant、分别只有 `cohort-a` / `cohort-b` 权限。报告保存在 Git 忽略的 `artifacts/clinical-eval/authz-sweeps/`，记录授权与拒绝计数、loopback 上下文读取 P95 和前后 RAM/磁盘快照。通过只表示该版本的合成评测路由没有越过内存数据集的 tenant/access-group 规则；不代表生产 SSO、真实身份核验、持久化存储行级安全、跨设备吊销或临床安全验收。

2026-10-11 为避免改写或重启正在使用的 Gateway，在独立 loopback 端口 `8326` 临时启动同一工作区版本的 clinical-evaluation Gateway；两组随机合成账号只存在于该 PowerShell/Node 进程环境，完成 sweep 后即关闭。最新结果为 [`authz-sweep-20261011-084132.json`](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261011-084132.json)：固定 dataset seed `huiyi-authz-sweep-20261011`、300 个合成患者、3 个 Encounter/患者、600 次读取；150 次授权通过、450 次越权拒绝、0 次未授权成功、0 个意外状态，读取 P95 1.13 ms；跨账号删除 404、所有者删除 204，退出后读取患者列表为 401。`modelGenerationRequests=0`，脚本耗时 7,394.06 ms，RAM/磁盘快照前后相同。Gateway 启动于临时端口 8326，测试后端口监听为 0；8321 常驻 Gateway 未修改且仍健康。报告绑定 revision `492595785b61ab795e60588212997a646a805aa2` 和相关源码指纹 `8bba33a9758fc54f4ea0788f4678b864743f3a95200945bfc8fcf01305b3ea60`；报告文件 SHA-256 为 `1983A5B18ED72EB5E28E5E65DE0167C5CC217BC83B3C8AB2B74853F45880B6A6`。该结果仅覆盖隔离实例中的应用层合成授权代码路径，不能当成 8321 当前进程配置或生产安全证明。

## 5. 盲审、批准与计分

人工审核仅处理 synthetic packet，逐轮核对关键任务、历史事实的正确/漏引/错误、医学断言支持及引文、风险信号、复杂病例覆盖和草稿状态。高风险漏报、错误患者事实、证据错误必须单独标记。第二位审核者可独立复制 packet 并评分；在融合前保留每位 reviewer 的记录，报告一致性及分歧解决方式。不能让模型自评分替代临床审核。A/B 配对任务率只纳入同一合成患者、同一轮次且两组均已 adjudicate 的项目；患者是 bootstrap cluster，报告 95% 区间和配对患者/轮次数。未完成临床审核时指标仍保持 `null`。

合成病例审批模板绑定 Cohort 文件 hash：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- approval-template --cohort=artifacts/clinical-eval/cohort-300.jsonl
```

模板中的临床审核者身份/角色必须由持证临床审核者真实填写；本地 JSON 是自我声明元数据，并非密码学签名或机构身份验证。审核完成后，使用私有 review key 回并盲审 packet，再 `finalize` 重算报告：

```powershell
pnpm --filter @huiyi/demo-gateway clinical-eval -- merge-reviews --packets=artifacts/clinical-eval/runs/<studyRunId>/review-packets.jsonl --key=artifacts/clinical-eval/private/<studyRunId>/review-key.json
pnpm --filter @huiyi/demo-gateway clinical-eval -- finalize --run-dir=artifacts/clinical-eval/runs/<studyRunId> --approval=artifacts/clinical-eval/cohort-300.jsonl.approval.json
```

默认审阅模板写在私有目录；导出的临床指标只有 Cohort approval hash 匹配且全部相应轮次被 adjudicate 后才释放。仅一例不能支撑推广性结论；最终应报告病例级分母、错误明细、置信区间、失败/跳过、协议和配置。

## 6. 产物与对外数字

- `manifest.json`：模型标识、cohort hash、split、并发、输出限制、服务地址与运行数。
- `runs.jsonl`：逐轮输入/输出、工具及 evidence 元数据、状态、时延和可用 token 计数；新 run 另记录 Gateway 观察到的 RAG 模式、planner/retrieval 次数、延迟、语料版本和 token 计数，不记录检索 query、hash、完整 evidence 或患者原文到 RAG telemetry。仅合成资料，但仍按评测资料限制访问。
- `review-packets.jsonl`：供盲审的合成模型输出；组别与解盲映射保存在 private 子目录。
- `score-report.json`：临床指标未批准或未人工 adjudicate 时为 `null`，不是 0%；每臂仍会列出执行状态和 Gateway 观察到的 RAG 工程遥测，遥测不能替代临床评分。
- `isolation-probes.jsonl`：只记录状态、计数式结果和清理状态，不含 canary。
- `authz-sweeps/*.json`：Gateway 合成身份/患者范围矩阵与本机资源快照；不是生产访问控制证明。
- `draft-bundles.jsonl`：合成 FHIR-shaped 初稿，状态为 preliminary，不写回任何 EMR。

当前 smoke 与失败项应引用 [证据台账](../product/evidence-backed-project-profile.md) 和实际 run manifest；禁止把目标简历数字、论文数字、计划轮数或组件单测当作本地临床效果成绩。

## 7. 自适应 Luna smoke 与源码追溯

2026-10-11 使用 v2 cohort 单例 `HCE-0001`、integrated arm、Codex app-server 上的 GPT-6-Luna 和 `--patient-simulation=adaptive --patient-followups=1` 运行 `20261010233709-f18a6c77`。该病例的 8 个任务均已尝试，7 个 completed、1 个以 `TURN_TIMEOUT` 失败；记录到 10 次 assistant exchange、3 次模拟患者追问、8 个已完成协作子运行和 3 条 RAG evidence。Health Engine 实际 attestation 为 AMA 与 RAG planner=`gpt-6-luna`、endpoint=`http://127.0.0.1:8334/v1/chat/completions`、embedding=`Qwen3-Embedding-0.6B`。这次 RAG 调用是 single mode，`plannerCalls=0`；独立的 iterative RAG 测试见前文，不要合并成临床回合中的 iterative RAG 成绩。

该历史 manifest 的总状态是 `partial`，临床计分状态为 `blocked-unreviewed-cohort`，审核未完成，临床指标保持 `null`。旧 SSE reader 先把整个响应读完再解析；失败流超时后，其已收到的部分工具事件未保存，因此历史失败回合的 exchange/tool 计数不完整。runner 已改为逐 chunk 解析并保留超时前事件，定向回归测试覆盖该场景；旧产物保持原样，不回填或重算。

该历史运行开始前/结束后 C/D/E 可用空间约为 8.8/179.7/131.3 GiB，空闲 RAM 约 10.7→9.4 GiB，GPU 显存占用约 11,795/16,376 MiB；没有下载模型、语料或依赖。该 manifest 生成于源码指纹功能加入之前，不能追溯为带指纹的运行。后续新 run 会在 manifest 写入 Git revision、相关工作区是否 dirty，以及只覆盖 evaluator/runtime 源码和依赖清单的 SHA-256 与文件/字节数；模型和语料目录不会被读取。resume 必须保持同一指纹，否则应新建 run，避免把不同代码版本混在一份结果里。

新版本还会把 DSH→Gateway 已观察到的结构化 RAG 指标附在每轮记录中；生产 Agent Activity 仍只保留已允许的摘要计数，患者 query 和 evidence 正文不会进入这些 telemetry。子 Agent 内部工具若未由 Gateway root observer 发出事件，不会被假定为已统计；后续大批次前还要确认所有预期检索调用都可归因。

若 Codex 生成额度较紧，可先只检查本地向量召回，不调用 planner：

```powershell
.\scripts\eval\rag-iterative-smoke.ps1 -Profile bilingual -Mode single
```

2026-10-11 的脚本化检查结果为 [`rag-single-20261011-082052.json`](../../artifacts/clinical-eval/rag-smokes/rag-single-20261011-082052.json)：双语查询 2/2 通过、每次返回 3 条 evidence，延迟 284.0 / 283.2 ms，`plannerCalls=0`；英语命中 PubMed/StatPearls，中文命中 PubMed。`modelGenerationRequests=0`。运行前后空闲 RAM 9.0 GiB、GPU 显存 11,795/16,376 MiB，C/D/E 可用空间 8.8/179.7/131.3 GiB，Health Engine 工作集 9.6 GiB；没有下载模型、语料或依赖。这个模式不验证 iterative planner，也不代表 DSH 临床回合的 RAG 行为。

## 8. 单轮认证 DSH→RAG 遥测 smoke

2026-10-11 通过 Codex app-server 上的 GPT-6-Luna 运行 [`smoke-20261011003020-0a681999.json`](../../artifacts/clinical-eval/smokes/smoke-20261011003020-0a681999.json)。这是 1 个合成 HCE-0001 T07：认证 Gateway 为真，DSH `run.completed`，触发 `search_medical_evidence`，单轮本地 RAG 返回 3 条 StatPearls evidence；检索 257.2 ms、1 次 retrieval、0 次 planner、无降级。Gateway `evidence.completed` 中的结构化检索遥测与 Health Engine 的直接计数相符，说明这次工具执行可在 Gateway 侧归因。AMA 2 项操作共 4 次模型调用、0 失败；合成记忆清理核验通过。总耗时 30.531 秒，DSH root 用量 37,468 input / 248 output tokens；AMA 89,043 prompt / 343 completion tokens。该次没有调用协作工具。

该 smoke 只验证一条工程路径，不提供临床评分、证据支持率、答案质量或协作成绩。当天索引 health 为 5 个来源、823,450 chunks，语料版本 `medtext-local-cc7d43568501e6b7`。运行后空闲 RAM 约 9.03 GiB、GPU 显存 11,795/16,376 MiB、C/D/E 可用空间约 8.8/179.6/131.3 GiB；没有下载模型、语料或依赖，服务未重启。Smoke 产物 3,205 bytes，SHA-256 `1C14FC20D54E55D32FE9932733176C48DAA3CDA251D846F7AF8230B4F2793D61`；产物保留结构化计数和 query hash，不保存原始 query、回答或 evidence 正文。

## 9. Strict JSON Schema iterative RAG 与 AMA 超时回归

此前 Luna bridge 没有把 OpenAI-compatible `response_format` 传递给 Codex app-server，导致 iterative planner 的结构化输出约束丢失。Gateway bridge 现校验并传递 strict JSON Schema，拒绝不支持的 schema 形状以及与 DSH tools 同时使用的 JSON Schema 请求；planner 使用包含 `queries` 数组的 schema。新增 bridge 与 Health Engine 回归测试覆盖请求和返回序列化。

修复后通过一次 DSH→认证 Gateway→iterative RAG smoke：[`smoke-20261011022256-9e17696e.json`](../../artifacts/clinical-eval/smokes/smoke-20261011022256-9e17696e.json)。Luna planner 完成 2 轮、产生 4 个查询并触发 4 次检索；共 12 个候选、8 篇去重文献、3 条 evidence，没有降级。RAG 用时 12.84 秒，planner 34,621 input / 137 output tokens；DSH root 37,875 / 402 tokens；AMA 4 次调用、89,129 / 451 tokens，清理通过；全程 48.38 秒。这只验证一个合成 evidence 轮的工程链路，不是检索稳定率或临床质量成绩。

一次 HCE-0001、两个 Encounter、single-agent/integrated 各 8 轮的配对工程 pilot 记录在 [`20261011022745-570f5df4`](../../artifacts/clinical-eval/runs/20261011022745-570f5df4/score-report.json)。DSH 16/16 主轮次完成；integrated 观察到 1 次协作子运行和 1 次 single RAG（3 条 evidence、303 ms）。运行期间发现 pinned AMA wrapper 将 HTTP 请求超时固定为 60 秒：末次 memory-retrieval-decision 耗时约 60.014 秒后失败，导致最后一次 Encounter commit 未完成。此错误没有从临床计分中隐藏，16 个盲审包仍 pending，临床指标保持 `null`。

针对这个明确的工程故障，pinned AMA wrapper 现在读取 `HUIYI_MEMORY_MODEL_TIMEOUT_SECONDS`（默认 60 秒，允许 1–300 秒）；GPT-6 Health Engine 启动脚本将本机评测值设为 90 秒。trace 会保留 `AmaBackendError` 的错误类别。AMA/RAG 定向 Python 测试共 25 项通过，bridge Vitest 8/8 通过，Gateway TypeScript `tsc --noEmit` 通过。变更后的 Engine 配置指纹匹配预期；随后运行的 run-scoped AMA isolation probe 为 pass：双方 canary 自身召回成功、交叉泄漏 0、清理核验通过。隔离探针只覆盖本机 Health Engine 的合成 AMA namespace，不证明 Gateway/生产租户隔离。此段记录时配对 pilot 尚未重跑；第 10 节记录了使用同一单例配对设置的后续回归，不能据此宣称临床任务成绩。

临时验证服务只在 loopback 端口运行，结束后已停止；原有端口服务没有修改。本轮未下载模型、语料或依赖。若复跑配对 pilot，应使用同一固定 cohort、低并发并先检查本机资源；不要直接把单病例用量线性包装成 300 例预算或临床成绩。

## 10. AMA 90 秒 timeout 修复后的配对回归

2026-10-11 以同一 `cohort-300.jsonl` development 首例 `HCE-0001`、`scripted` 模拟、`single-agent`/`integrated` 两臂各 8 轮，重跑旧 60 秒 AMA 超时配对 pilot。运行前 Health Engine 只读 attestation 为 AMA 与 RAG planner=`gpt-6-luna`，endpoint=`http://127.0.0.1:8335/v1/chat/completions`，embedding=`Qwen3-Embedding-0.6B`；索引 5 源/823,450 chunks。单例隔离 Engine 使用 `HUIYI_MEMORY_MODEL_TIMEOUT_SECONDS=90`，并发 1、DSH `max-tokens=384`、轮次超时 300 秒。命令从 `services/demo-gateway/` 目录执行：

```powershell
$env:HUIYI_DEMO_BACKEND='dsh'
$env:HUIYI_DEMO_MODEL_BACKEND='codex-app-server'
$env:HUIYI_CODEX_BRIDGE_API_KEY='local-only'
$env:HUIYI_CODEX_BRIDGE_URL='http://127.0.0.1:8335/v1'
$env:HUIYI_HEALTH_ENGINE_URL='http://127.0.0.1:8326'
$env:HUIYI_DEMO_SYNTHETIC_AMA_MEMORY='1'
node --import tsx ../../eval/clinical/cli.ts run --cohort=artifacts/clinical-eval/cohort-300.jsonl --split=development --limit=1 --arms=both --patient-simulation=scripted --synthetic-ama-memory=true --memory-commit-batch-turns=4 --concurrency=1 --max-tokens=384 --turn-timeout-ms=300000
```

产物 [`20261011024751-2f48d480`](../../artifacts/clinical-eval/runs/20261011024751-2f48d480/score-report.json) 记录 DSH 16/16 completed、0 failed；single-agent P50/P95=`5.59/7.75s`，DSH root 用量 `139,872 input / 1,512 output`。Integrated P50/P95=`17.00/130.96s`，root/direct children 用量 `379,517 input / 3,516 output`；观察到两次协作工具调用，分别 1 和 6 个 child，共 7/7 成功、均未降级。单次本地 RAG 为 single mode，3 条 evidence、290 ms、未降级；没有 iterative planner。

该 run manifest 冻结 cohort SHA-256=`6e2d5b40bcf70026f2236e1a7730847368410ab263b7eefe72cc71fe28aab4ee`，source fingerprint 的 Git revision=`492595785b61ab795e60588212997a646a805aa2`、`relevantWorkingTreeDirty=true`、源码 SHA-256=`3d1898936d8522c9321149df0da5abd836a2456bbf0e54ebcf5631dbd3e5ecf3`（116 个文件/1,086,052 bytes）。Engine 路由 hash=`dc4552ae0db55258b25d31c5e9bdc6347bcd00cf9a625beebca9bfe07660da9a`；正式复核应以 manifest 和 score report 为准。

集成组 16 条 AMA telemetry 中，两次 automatic recall 均完成（首次空 namespace 返回 0 项；下一个 Encounter 返回 9 项），两次 Encounter commit 都完成，耗时 `28.12s` 和 `17.79s`。AMA 模型共 10 次调用、`218,670 prompt / 1,209 completion` tokens、0 个失败操作；这次没有再出现上一次 60 秒处的末次 commit timeout。新 run 的盲审包 16/16 仍 pending，`pairedTaskCompletionDelta` 与临床指标继续为 `null`；该 run 自身的 memory-isolation probe 为 `not-run`，不能用另一 run 的隔离测试替代。

这是一次相同单病例协议下的工程 timeout 回归，说明这次 AMA recall、两次 commit、一次协作与一次 RAG 均执行完成；不能证明 timeout 是旧故障的唯一原因，也不能据此声称临床任务完成率提升。集成 P95 主要反映一个含 6 个 child runs 的协作轮，不能代表多病例或持续并发服务。运行时 Codex app-server 通过本机授权状态工作；bridge、Health Engine 和评测只绑定 loopback。Health Engine 启动后、模型请求前空闲 RAM 为 `12.27 GiB`，4090 显存占用约 `11,795/16,376 MiB`；启动服务前的磁盘快照 C/D/E 可用空间为 `8.55/179.66/131.33 GiB`。结束服务并清理临时记忆目录后，空闲 RAM 回到 `19.72 GiB`，C/D/E 可用空间仍约为 `8.55/179.66/131.33 GiB`；仅删除了该 run 专属 49,041-byte 合成记忆目录，使用已有模型/index，没有下载安装任何东西。原有模型与 corpus 文件保留。

## 11. Bounded Luna bridge 的 DSH child overlap 工程 smoke

为验证并发门控不是只对两条独立 HTTP 请求有效，另运行一次明确标为工程路由检查的合成用例：Gateway → DSH → `consult_clinical_team`。Luna 桥接器 `maxConcurrentTurns=2`；smoke 仅使用已有 GPT-6-Luna app-server、Health Engine、Qwen3 embedding 和本地索引。桥接器健康计数采样 592 次、采样失败 0，观察到活动请求峰值 `2/2`、排队峰值 0。根 Agent 完成，协作工具调用完成；advanced 路径启动 6 个子运行，5 个完成、1 个失败，因此协作结果 degraded，child token telemetry 只观测到 5 个 session、归因不完整。bridge 同期有一个脱敏错误类别 `invalid_model_response`，当时没有将该类别与单个 child 关联。DSH root 37,433 input / 66 output tokens，已观测 child 合计 132,550 tokens；AMA 4 次调用、89,848 prompt / 541 completion tokens、0 个失败操作。单次本地 RAG 返回 3 条 StatPearls evidence，426.6 ms，未降级。端到端耗时 123.13 秒，memory cleanup 已核验通过。

产物为 [`smoke-20261011030807-d7e1c267.json`](../../artifacts/clinical-eval/smokes/smoke-20261011030807-d7e1c267.json)。其原始 `status` 是 `passed`，表示根回合、协作工具及并发峰值等 smoke 断言满足；不能据此忽略协作对象内明确记录的 `5 completed / 1 failed / degraded`。smoke 脚本现已改为遇到任一失败 child 时报告 `degraded` 并返回非零，并在之后的 smoke 中附上不含 case hash、prompt、回答或 child ID 的任务类别/耗时/安全错误类别汇总；不重写旧产物。此次结果只能证明这一次 bounded overlap 被实际观察到，不能宣称协作完整成功、线程压力隔离通过、临床质量或稳定率。它不是临床评估，未进入任何临床计分。

本次进程只临时绑定 `127.0.0.1:8326` 与 `127.0.0.1:8335`；两项服务现已停止，run-scoped 48,240-byte 合成记忆目录已删除。运行时可用 RAM 约 `9.2–9.5 GiB`，4090 Laptop 显存约 `11,841/16,376 MiB`；完成清理后 RAM 为 `19.83 GiB`，C/D/E 空闲空间为 `8.63/179.76/131.33 GiB`。未下载模型、语料或依赖，也未修改原有模型及 corpus 文件。

## 12. 离线回归与当前监听器预检

2026-10-11 对当前工作树运行的离线回归为：核心 Vitest `97/97`、Demo Gateway `42/42`、前端 `8/8`、Health Engine pytest `42` 项全通过；核心 clinical/eval TypeScript no-emit 检查、Gateway TypeScript 检查和前端 TypeScript no-emit 检查均通过。trace summary 单测证明失败类别可记录，同时排除 case hash、生成角色和 child ID；新增的 bridge attestation 单测验证旧 healthz 或越界并发上限会被拒绝。Vite 6.4.4 的 `production` 与 `clinical-evaluation` 两种构建均成功；两次 `check-production-build.mjs` 都扫描五个产物文件通过，client bundle 没有携带已检查的 Gateway/model API-key 环境变量名。无一项测试调用模型或下载依赖/语料。第一次误用 Anaconda base Python 收集 Health Engine tests 失败；随后用仓库现成 `services/health-engine/.venv` 通过完整 pytest suite，没有安装软件包。

同日对本机已有 listener 做只读探测：8333/8334 `/healthz` 均报告 `gpt-6-luna` 与 `codex-app-server`，但没有 `maxConcurrentTurns` 字段；8325 Health Engine 路由显示 AMA/RAG planner=`gpt-6-luna`、embedding=`Qwen3-Embedding-0.6B`、RAG 与 memory isolation 已开启，但 `healthEngineSourceSha256` 缺失。由于这些进程不是本次启动且无法完成代码版本/并发配置 attestation，不应把它们用于可复现临床生成批次；本次没有停止或重启它们，也没有向这些 listener 发送模型生成请求。开始新批次前先使用独立端口启动并 attestate 当前 worktree 版本，且先检查资源与 cohort approval。

随后用 `HUIYI_CODEX_BRIDGE_URL=http://127.0.0.1:8333/v1`、`HUIYI_HEALTH_ENGINE_URL=http://127.0.0.1:8325` 做一次单病例 `plan` 只读预检。返回 `plan-only-no-generation`，但 `preflightBlockers` 正确拒绝运行：8333 健康且模型/路由匹配，缺少 bounded concurrency counters（cap 为 null）；8325 的 AMA/planner endpoint 与选定的 8333 bridge 不一致，Health Engine source fingerprint 也缺失。该检查只请求 bridge `/healthz` 和 Health Engine `/health`、`/_internal/evaluation/config`，没有调用生成模型或实际 RAG 检索。这证明常驻旧 listener 不能用于当前可复现 integrated run，不代表当前 worktree 启动失败。

为验证当前代码，在空闲 loopback 端口临时启动当前 worktree Codex bridge `8335`（并发上限 2）和 Health Engine `8326`。启动脚本 `-CheckOnly` 核实本机 Qwen3-Embedding-0.6B 和五源 `823,450` chunk 索引；Health Engine 使用 CPU 编码/检索。单病例 `plan` 返回 `preflightBlockers=[]`，bridge/AMA/planner endpoint 全部一致，`bridgeMaxConcurrentTurns=2`，Health Engine source SHA-256=`dc4552ae0db55258b25d31c5e9bdc6347bcd00cf9a625beebca9bfe07660da9a`。这次只读预检没有模型生成或实际向量查询。临时服务随后停止，8335/8326 监听器均释放；删除了本次创建的唯一 run-scoped 合成记忆文件/目录（20,480 bytes）。Health Engine 峰值工作集约 7.20 GiB，可用 RAM 最低约 19.76 GiB、停止后约 26.82 GiB；4090 显存保持约 11,841/16,376 MiB，C/D/E 可用空间检查前后为 8.61/179.76/131.34 GiB。没有下载模型、语料或依赖，也没有重启原有服务。

为让招聘评估材料中的“零越权”有当前代码证据，另在隔离 Gateway `8326` 上重跑 300 例/3 Encounter 授权 sweep，产物 [`authz-sweep-20261011-113558.json`](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261011-113558.json)。600 次上下文读取中 150 次按 scope 授权、450 次越范围拒绝，0 次未授权成功、0 个意外状态，P95 1.23 ms；跨账号删除 404、所有者删除 204、登出后患者列表 401。只调用 Gateway 登录/上下文/会话/退出接口，模型生成请求为 0。运行耗时 2.449 秒，RAM 26.8→26.7 GiB、磁盘快照未变；临时 Gateway 已停止，8326 无监听。范围仍限于当前捕获源码的本机 loopback 和内存合成数据，不证明生产 SSO、公网或数据库隔离。

## 13. 当前工作树 Luna 集成 smoke 与 bounded bridge attestation

为避免 smoke 脚本绕过 clinical-eval 的并发门槛，`scripts/eval/gpt6-integrated-smoke.ts` 现在在任何模型调用前读取 bridge `/healthz`，必须验证 GPT-6-Luna、Codex app-server、健康状态和 1–4 的有界并发计数；运行中采样会再次校验模型/路由/计数，记录 cap 变化并失败，任一采样失败也会令 smoke 失败，成功产物记录已 attested 的 cap。runbook 与 clinical-eval 共享 `attestCodexBridgeHealth`。`tsconfig.test.json` 现在也包含 `scripts/eval/**/*.ts`，让常规根级 no-emit 检查覆盖该 smoke 入口。

本次只用仓库已有模型和索引，在临时 `127.0.0.1:8335` bridge（cap=2）与 `127.0.0.1:8326` Health Engine 上验证；Health Engine `-CheckOnly` 确认本地 Qwen3-Embedding-0.6B、5 源/823,450 chunks、CPU 检索，模型没有下载或重建。首个两轮 smoke [`smoke-20261011034329-4425edaf.json`](../../artifacts/clinical-eval/smokes/smoke-20261011034329-4425edaf.json) **失败**：第一轮 `consult_clinical_team` 的 6/6 子运行均完成、AMA commit 与 cleanup 通过；第二轮 RAG 已检索 3 个候选，但最终 GPT-6-Luna 结构化响应被 bridge 拒绝（安全类别 `invalid_model_response`），因此 run 为 1 个已完成/1 个失败，不能算端到端通过。bridge 观测 563 次，cap 始终 2、活动峰值 2、排队峰值 1、采样失败 0；DSH 用量 205,225 tokens，AMA 89,422 prompt / 480 completion tokens。没有保存回答正文。

只为隔离该故障，后续各运行一次证据单轮：single smoke [`smoke-20261011034606-7c1fbbd6.json`](../../artifacts/clinical-eval/smokes/smoke-20261011034606-7c1fbbd6.json) 通过，RAG 返回 3 条 StatPearls evidence、1 次检索、592.6 ms、未降级；DSH 37,402 / 251 tokens，AMA 4 次调用、89,517 / 340 tokens、清理通过，总计 30.694 秒。iterative smoke [`smoke-20261011034654-b2d0447f.json`](../../artifacts/clinical-eval/smokes/smoke-20261011034654-b2d0447f.json) 通过，Luna planner 2 轮产生 4 个查询，本地检索 4 次，12 个候选/7 篇去重文献/3 条返回 evidence，RAG 10.211 秒（planner 7.943 秒、retrieval 2.269 秒），无降级；DSH 37,971 / 491 tokens，AMA 4 次调用、89,720 / 429 tokens、清理通过，总计 46.600 秒。两个成功产物中的 bridge cap 都保持 2，AMA synthetic memory 清理核验均通过。

本次只证明有界并发 attestation、协作路由和 single/iterative evidence 工程链路分别能工作；全量两轮 smoke 曾失败，single 与 iterative 成功样本也没有在同一回合覆盖协作+RAG，不能宣称临床评分、答案质量、证据支持率或稳定率。三次运行单轮 AMA 都使用约 89k prompt tokens、4 次模型调用。pinned AMA `forwardUser` 对每条输入依次执行 Retrieve 与 Judge，并并行执行 Episode Judge 与 Fact Construct；这提示记忆调用的 prompt/context 成本是扩大病例评测前需要优先优化/核算的主要成本，但这次没有修改 AMA 行为。服务随后停止，8326/8335 无监听；仅清理本轮 `memory-codex-gpt6-synthetic-20261011-114234` 目录，所有索引、模型和原有 listener 均未改动。

随后将显式 smoke focus 扩展为 `integrated`，只选择同一 Encounter 的 T06 与 T07，支持在安全轮完成后对证据轮应用 iterative mode。复跑时先按前文启动临时 bridge/Health Engine，然后设置：

```powershell
$env:HUIYI_CODEX_BRIDGE_API_KEY = 'local-only'
$env:HUIYI_CODEX_BRIDGE_URL = 'http://127.0.0.1:8335/v1'
$env:HUIYI_HEALTH_ENGINE_URL = 'http://127.0.0.1:8326'
$env:HUIYI_GPT6_SMOKE_FOCUS = 'integrated'
$env:HUIYI_GPT6_SMOKE_RAG_MODE = 'iterative'
$env:HUIYI_DEMO_MAX_TOKENS = '768'
pnpm clinical:eval:smoke
```

组合产物 [`smoke-20261011035501-51e5a0a4.json`](../../artifacts/clinical-eval/smokes/smoke-20261011035501-51e5a0a4.json) 通过：两轮均 `run.completed`；T06 的 `consult_clinical_team` 与 single RAG 完成，协作路径为 basic/1 个 classifier child；T07 的 iterative RAG 2 轮、4 个查询、4 次 retrieval，12 候选/7 篇去重文献/3 条返回 evidence，无降级。两个回合 AMA 共 9 次调用、0 失败；DSH tokens 分别为 `55,210/290`、`38,831/295`，AMA 分别 `88,948/377`、`109,077/530` prompt/completion tokens。总时长 79.979 秒。bridge 采样 385 次、cap 始终为 2、活动峰值 2、排队峰值 0、采样失败 0；清理核验通过。

这个组合样本将协作、AMA 和 i-MedRAG 放在一个连续 synthetic Encounter 中，但只有 basic/1-child 协作；此前 six-child 样本有 6/6 child 完成，却在后续 evidence final response 失败。当前没有一次 successful run 同时证明 advanced multi-specialist fan-out 与 iterative RAG；不能把两个不同样本拼成 6-child 组合成绩。首次尝试组合 smoke 时脚本配置校验拒绝了非法 focus/mode 组合，未发出模型请求；新增 `focus=integrated` 是受控的明确入口。

并行完成的授权完整性修复位于 `services/demo-gateway/src/clinical-evaluation/dataset.ts`：数据集导入患者记录时复制白名单字段、嵌套 Encounter 与 turn plan；`getPatient()` 返回独立副本，防止调用方变更 tenant/accessGroup 或病程污染后续授权判断。针对性 `clinical-evaluation.test.ts` 为输入对象突变及返回对象突变新增覆盖，Gateway 构建通过。测试仅用小型合成集，未运行模型评测。

继续检查严格组合门槛时，首次尝试 [`smoke-20261011040417-c9f46c01.json`](../../artifacts/clinical-eval/smokes/smoke-20261011040417-c9f46c01.json) 中的协作已完成 advanced 路径 7/7 child、0 失败，但 T07 没有发出 RAG 工具调用。根因是 smoke 把“强制协作”的提示错误套到了第二轮，遮住了 iterative 检索指令；这个失败样本保留，不能当作三者组合通过。脚本现将显式协作限定为第一个选定轮次，并在 `integrated` 两轮 smoke 默认按 2 轮合并一次 AMA commit。另修复了协作 trace：classifier child 现在记录其解码后的复杂度，而非分类前默认值；新增回归测试。

按修正后的门槛复跑 [`smoke-20261011040708-75371b57.json`](../../artifacts/clinical-eval/smokes/smoke-20261011040708-75371b57.json)，整体仍为 **failed**，但逐项证明了一些链路：T06/T07 根回合均完成；T06 classifier 后，MDT planner 返回结果未通过计划校验，协作降级并且未达到 6-child 门槛；T07 确实调用 iterative RAG，Luna planner 2 轮生成 4 个查询、本地检索 4 次，12 个候选/10 篇去重文献/3 条返回 evidence（PubMed、Textbooks），约 12.25 秒，无降级。AMA 两轮合并为 1 次 commit、4 次 Luna 调用，91,813 prompt / 277 completion tokens、23.27 秒；记忆清理通过。桥接 cap=2，385 次采样、活动峰值 2、排队峰值 0、采样失败 0；总时长 80.224 秒。没有保存任何回答或 evidence 正文。

因此仍没有一条完整通过的“advanced 多专科协作 + AMA + iterative RAG”样本：前一次 advanced 子运行通过但测试提示覆盖了 iterative 指令；修正后的样本中 iterative RAG 与 AMA 通过，但 MDT 结构化规划失败。不能将两条不同运行拼成成功率或临床成绩。单条两轮 smoke 的 AMA 合并提交观察值比过去逐轮提交观察值少一半调用，但这只是工程预算线索，尚非控制变量成本基准。修正的 smoke 首次启动时 Health Engine 仍在加载本地索引，预检立即退出且没有模型请求；等待 `Application startup complete` 后才运行第二次。启动前资源快照为 RAM 26.65/63.75 GiB、C/D/E 盘可用 8.6/179.8/131.3 GiB；未下载或重建模型、语料、索引或依赖。结束后停止本轮 bridge/Health Engine，删除仅用于本轮的 `memory-codex-gpt6-synthetic-20261011-120257`；8333/8334/8325 等原有 listener 未停止或修改。

为让之后的结构化失败可定位，`DshClinicalChildRunner` 现把已知 decoder 错误转换成 allowlist `validationCode`（包含 MDT plan 无有效 team），仍丢弃原始 structured output 与错误文本；classifier trace 则记录实际解码决策。最终离线验证：`pnpm typecheck` 通过；根测试 99/99、Gateway 测试 43/43 通过，`git diff --check` 通过。

随后修正 MDT planner 提示与 decoder 的契约：advanced 阶段至少返回一个非空 team、每个 team 至少一名成员，第二组仅在有独立目标时增加。按相同 cap=2、相同 HCE-0001、两轮 AMA 合并和 iterative RAG 条件再次运行，产物 [`smoke-20261011041402-a3abe671.json`](../../artifacts/clinical-eval/smokes/smoke-20261011041402-a3abe671.json) **通过严格工程门槛**：T06 `consult_clinical_team` advanced，classifier/MDT planner/3 个 specialist analysis/2 个 team synthesis/moderator 共 7/7 child 完成、0 失败、未降级；DSH child session token attribution 为 7/7 完整。T07 在同一 Encounter 调用 iterative RAG，Luna planner 2 轮生成 4 个查询，本地 retrieval 4 次，12 候选/7 篇去重文献/3 条返回证据，来源为 Textbooks 与 PubMed；RAG 12.125 秒、未降级。两轮均 `run.completed`。

本次总耗时 145.078 秒；bridge cap=2，704 次采样、活动峰值 2、队列峰值 1、0 采样失败/attestation mismatch。AMA 把两轮输入合并一次 commit，4 次 Luna 调用、89,841 prompt / 648 completion tokens、16.948 秒；0 失败，synthetic namespace 清理为零记录。DSH 两轮共 217,477 input / 1,076 output tokens。产物没有回答正文、患者文本或证据片段。这是一条明确强制工具路由的单病例工程 smoke，可用于描述 DSH/MDAgents-derived、AMA 与 i-MedRAG 的一条端到端链路已经打通；它不能估算协作成功率、临床完成率、证据支持率、稳态延迟或 300 例指标。MDT 提示修改与通过结果相关，但单例前后尝试不是受控可靠率比较。

第三次 smoke 后停止本轮 `8335` bridge 和 `8326` Health Engine，删除 `memory-codex-gpt6-synthetic-20261011-121309`；旧的 8325/8333/8334 进程未触碰，也没有模型、语料、索引或依赖下载。增加 MDT 非空计划提示及验证类别回归后，根测试为 100/100、Gateway 为 43/43；`pnpm typecheck`、根与 Gateway TypeScript build、artifact 结构性验收和 `git diff --check` 均通过。

## 14. 2026-10-11 单病例 adaptive 集成臂运行

本轮首先对现有 listener 做只读检查：旧 bridge `8333/8334` 的 `/healthz` 没有 bounded-concurrency 字段，`8325` 的 evaluation config 未启用且无当前 Health Engine 源码指纹。保留了零生成请求的失败预检 [`plan-20261011-live-route.json`](../../artifacts/clinical-eval/plans/plan-20261011-live-route.json)，没有向旧服务发生成请求。随后使用当前 worktree 临时启动 bridge `127.0.0.1:8335`（GPT-6-Luna，max concurrency=2）和 Health Engine `127.0.0.1:8326`；Health Engine 用 CPU 加载本机已有的 Qwen3-Embedding-0.6B 与 5-source/823,450-chunk 索引。匹配的只读预检见 [`plan-20261011-isolated-route.json`](../../artifacts/clinical-eval/plans/plan-20261011-isolated-route.json)，所有 route/source checks 通过，无 blocker。

运行：HCE-0002，一个合成患者、integrated arm、adaptive patient simulation、每个任务最多一次追问、max output setting=768、并发 1。结果位于 [`20261011042740-079628e5`](../../artifacts/clinical-eval/runs/20261011042740-079628e5)：8/8 task records completed；共 11 根 assistant exchange、3 条模拟患者 follow-up；DSH 408,393 input/4,057 output tokens，其中根模型 255,119/2,740、6 个 child session 153,274/1,317；AMA 10 次调用，215,491/1,323 tokens，0 失败；首次协作 complexity=intermediate，6 child run、0 失败、未降级；一轮 `search_medical_evidence` 返回 3 条 evidence（single RAG）。总 wall time 221.8 秒。其后单独运行的 [`isolation-probes.jsonl`](../../artifacts/clinical-eval/runs/20261011042740-079628e5/isolation-probes.jsonl) 为 `pass`：两侧 own recall matched、cross-patient canary 未泄漏、两侧 cleanup verified。重新执行 `finalize` 后 CLI 摘要为 `memoryIsolation=passed`、`clinicalMetricsStatus=blocked-unreviewed-cohort`；队列仍是 0/30 临床批准，因此没有临床成绩。namespace 探针只证明本机合成 AMA memory 层，不代表 Gateway/SSO 或生产访问控制。

资源与清理：开始前 RAM free=26.9 GiB、E 盘 free=131.3 GiB；Health Engine 加载后 RAM free 约 19.5 GiB，运行期间最低观测约 16.1 GiB；关闭隔离服务后恢复至 26.7 GiB。`8326/8335` 两个本轮 listener 已停止，原有 `8325/8333/8334` 未动；本次新建的 run-scoped synthetic memory 目录已删除。没有下载模型、语料、索引或依赖。该单病例观测只供工程联调与预算，不可外推成复诊完成率、临床准确率、跨患者零泄漏或规模化延迟。30 例计划仍为最多 960 次根 assistant exchange（双臂、adaptive follow-up cap=1）；在临床 reviewer 完成批准且分阶段核算模型预算前，不启动该批量运行。

随后为同一 HCE-0002 补跑 `single-agent` 对照臂：[`baseline manifest`](../../artifacts/clinical-eval/runs/20261011044304-bc6b5256/manifest.json)，同 cohort hash、同 GPT-6-Luna、自适应上限 1；8/8 tasks completed，11 assistant exchanges、3 patient follow-ups，59.2 秒总 wall time，DSH 192,279/1,564 input/output tokens。与 integrated run 使用现有 scorer 离线汇总为 [`paired-hce-0002-engineering-score.json`](../../artifacts/clinical-eval/pilots/paired-hce-0002-engineering-score.json)：两臂各 8/8 completed、0 失败；按 turn 记录的 p95 是 baseline 10.86 秒、integrated 94.09 秒（集成臂有一次 6-child 协作回合），不能视作临床 SLA。集成臂 6 个 child run 完成、single RAG 返回 3 条 evidence、AMA 10 次调用；baseline 没有 RAG/AMA/协作。报告的 paired status=`blocked-unreviewed-cohort`，human review=0、paired clinical turns=0，临床质量指标均不可用。该 scorer 报告只增加同病例工程配对与额外调用成本观测，不代表任何临床任务完成率差异。

该病例的 AMA trace 还显示具体预算热点：22 条 operation trace 中，2 个 Encounter commit 均完成、各触发 4 次模型调用，合计 179,520 prompt / 1,169 completion tokens；自动召回有 2 条 completed trace（其中首次空 namespace 没有模型调用），合计 2 次模型调用、35,971/154 tokens，并只报告 1 个 retrieval round；另有 9 条 commit 与 9 条 recall 跳过。后续若压缩 AMA，必须用冻结 cohort 的患者历史正确召回与冲突更新指标验证，不能只以少 token 为成功。

## 15. 2026-10-11 cap-4 GPT-6-Luna strict collaboration smoke

为修正 cap-4 smoke 的事件计数并排查一例 child `turn/end=error`，使用已有本地模型、Qwen3 embedding 和 5-source/823,450-chunk 索引，只对同一合成 HCE-0001 safety turn 做单病例工程检查。首个产物 [`smoke-20261011044852-6e486688.json`](../../artifacts/clinical-eval/smokes/smoke-20261011044852-6e486688.json) 保留了旧评测器的 `GATEWAY_RAG_TELEMETRY_COUNT_MISMATCH`：一项检索被 `evidence.completed` 与协作结果各引用一次，且相同工具结果事件把 7 个 child runs 错加为 14。评测器现按安全 RAG 指标摘要指纹去重，另记原始引用数；child 数以 metadata trace 的实际 child run 为准。随后为 AMA session-end 生命周期增加单独的操作、token 与 episode 结果计数，产物 schema 提升为 v5。

计数修复后的首轮 [`smoke-20261011045434-33d8d234.json`](../../artifacts/clinical-eval/smokes/smoke-20261011045434-33d8d234.json) 得到真实结果：root turn 完成、一次 single RAG 返回 3 条 StatPearls evidence，AMA cleanup 通过；但 advanced MDT 为 6/7 child 成功，另一个 `specialist-analysis` 的 stop reason 是 `error`，所以严格验收失败。bridge 代码此前只对 app-server `failed` 状态重试一次，并不对 `error` 重试。现在 bridge 对 `failed`/`error` 各最多重放同一模型请求一次，取消、拒绝和其他状态不重试；host-side DSH 工具只在 bridge 返回后执行。`codex-app-server-bridge.test.ts` 定向测试 9/9 通过，RAG 去重/临床 eval 与协作回归两文件共 43/43 通过，`tsc --noEmit -p tsconfig.test.json` 通过。此次通过样本没有发生 app-server `error`，因此尚未实测 error retry 的恢复率。

之后一次全新单例 [`smoke-20261011045927-e07591bf.json`](../../artifacts/clinical-eval/smokes/smoke-20261011045927-e07591bf.json) 通过严格门槛：GPT-6-Luna/Codex bridge cap=4、活动峰值 3、492 次并发观测采样无失败；root turn completed；advanced collaboration 7/7 child completed、0 failed、未降级，child-session/token attribution 为 7/7；local single RAG 1 次、3 条返回 evidence、425 ms、未降级；AMA 4 次调用、91,774 prompt / 177 completion tokens、0 失败，commit 15.83 秒；AMA 合成 namespace 清理核验通过。总耗时 101.658 秒，DSH 合计 190,082 input / 818 output tokens（其中 child 153,040 tokens）。这只是一条单病例、明确要求协作路由的工程 smoke，不是临床成绩；cap=4 也未实际跑满，不能据此认为 cap=4 比 cap=2 更快或更稳定。

资源与清理：只使用已有模型和索引，未下载模型、数据、索引或依赖；Health Engine 在 CPU 上运行。运行前空闲 RAM 为 26.88 GiB，Health Engine 加载后约 19.16 GiB，停止后回到 26.68 GiB。D/E/C 盘可用空间分别约 179.75/131.33/8.56 GiB，验证前后没有可见变化；本轮隔离端口 `8326/8335` 已停止，旧 listener `8325/8333/8334` 未动。本轮与前一轮 smoke 对应的两个 run-scoped 合成记忆目录已按解析后的仓库内精确路径删除。临床 cohort 仍为 0/30 批准，不启动批量生成或临床计分。

## 16. AMA 首个 episode 边界回归

v5 smoke [`smoke-20261011051024-7120d23b.json`](../../artifacts/clinical-eval/smokes/smoke-20261011051024-7120d23b.json) 实际调用了一次 session-end，但结果为 `skipped`，没有创建 episode；AMA 本轮一次 commit 共 4 次模型调用（89,406 prompt / 844 completion tokens），合成 namespace 清理核验通过。该 smoke 的严格高级协作门槛也失败：MDT planner 在第 2 个 child run 返回 `error`，因此这不是端到端通过样本。RAG 返回 3 条 StatPearls evidence，单次检索约 539.6 ms；没有保存回答正文。

追查 pinned AMA 后发现首个 episode 边界判断有误：原逻辑将“episode 表为空”的默认编号 `1` 等同于已经存在 episode 1，导致首个 Encounter 的总结被跳过。现改为 episode 表为空时仍生成首个 episode，并补充两个无模型单测：空表生成一次、已有最新 episode 时不重复生成。`services/health-engine/tests/test_ama_backend.py` 定向回归为 **14/14 通过**；单测仅构造内存对象，没有初始化 FAISS、请求模型或创建持久记忆。

随后在确认 `8326` 与 `8335` 无可见 listener 的情况下做显式 loopback bind 检查，Windows 仍对两端口返回 `EADDRINUSE`；没有停止或改动任何旧进程。`8345` 与 `8346` 的 bind 检查通过，于是只在这两个新端口启动隔离 bridge/Health Engine。app-server initialize handshake 成功，bridge 健康检查确认 GPT-6-Luna、并发上限 2；Health Engine route attestation 确认 AMA/planner=`gpt-6-luna`、Qwen3 embedding、本地 RAG 和 memory recall isolation 均已启用，源码指纹匹配。启动诊断现在只输出安全白名单类别与 RPC 元数据；bridge 单测 9/9 通过。

修复后的单病例 evidence-only smoke [`smoke-20261011052221-16573104.json`](../../artifacts/clinical-eval/smokes/smoke-20261011052221-16573104.json) **通过其工程 smoke 门槛**：HCE-0001-T07 的根 turn 完成并调用一次本地 `search_medical_evidence`，返回 3 条 StatPearls evidence，1 次检索约 272.9 ms、无降级；GPT-6-Luna DSH 用量为 37,405 input / 231 output tokens。AMA commit 4 次调用、89,140 prompt / 413 completion tokens；session-end 再调用一次，生成了首个 episode（17,804 / 150 tokens）；AMA 0 个失败，memory cleanup 验证通过。bridge cap=2，167 次并发观测无采样失败；总耗时 34.243 秒。该 evidence-only smoke 没有调用多专科协作，不能与先前另一条失败的 advanced MDT smoke 拼成组合成功，也不是临床质量或 300 例复诊成绩。

资源与清理：Health Engine 加载后可用 RAM 最低读数约 9.24/63.75 GiB，服务停止后回到 16.94 GiB；C/D 盘可用空间保持约 8.60/179.75 GiB。E 盘可用空间在本轮观察窗口从 131.33 降至 112.37 GiB，停止服务后仍是 112.37 GiB；检查到 `E:\` 顶层目录及 `Health-Copilot-Models` 时间戳没有提供原因线索，因此不把变化归因于本 smoke，也不声称查明。没有下载、安装或重建模型、语料、索引或依赖。`8345/8346` 隔离 listener 已停止；旧 `8325/8333/8334` 未动。仅删除本次与上一条 AMA 边界 smoke 各自的精确合成记忆目录（约 47 KB/目录），保留两个 smoke artifact。由于 E 盘空间变化原因未明、当前空闲 RAM 基线也低于此前批次，暂停扩大生成批次，先复核磁盘变化来源。

## 17. 同病例组合 smoke 与纵向配对试点

随后确认 E 盘仍有约 112.38 GiB 可用，C/D/E 与新一轮运行前后保持稳定；只使用现有模型和索引，没有下载、安装或重建任何模型、语料、索引或依赖。当前 worktree 的只读配对计划 [`plan-20261011-hce0001-paired.json`](../../artifacts/clinical-eval/plans/plan-20261011-hce0001-paired.json) 对 HCE-0001 development 档案核验通过：8 个任务、single-agent/integrated 两臂、adaptive 患者模拟每任务至多一次追问，根 Agent 交互上限 32；GPT-6-Luna bridge 并发 cap=2，AMA、RAG planner、Qwen3-Embedding-0.6B 与 Health Engine 源码指纹均匹配，`preflightBlockers=[]`。此计划本身未发生成请求或执行向量检索。cohort hash 仍为 `7d70893f2ffab9f8711f5ac260a1f70729bef758fb41f7cae50afaa894a6310c`；病例审核仍 pending。

同一组合路径的单病例工程 smoke [`smoke-20261011052846-aad8dfc8.json`](../../artifacts/clinical-eval/smokes/smoke-20261011052846-aad8dfc8.json) **通过**：HCE-0001 T06/T07 的两次 root turn 均完成；T06 高级 DSH/MDT 协作完成 7/7 child runs、0 失败、未降级，child token 归因完整；协作上下文 single RAG 返回 3 条 StatPearls evidence。T07 经 Gateway 实际调用 iterative RAG，两轮生成 4 个查询、执行 4 次召回，从 12 个候选中去重为 7 篇并返回 3 条 PubMed evidence；RAG 未降级，总耗时 10.115 秒。AMA 两轮 Encounter commit 无失败，session-end 生成 1 个 episode，5 次 AMA model calls 共 107,807 prompt / 376 completion tokens；synthetic namespace cleanup 通过。DSH Agent Tree 共 227,125 input / 1,136 output tokens，其中 7 个 child session 合计 149,884 tokens；bridge cap=2，活动峰值 2、排队峰值 1，690 次采样无失败。总耗时 141.840 秒。该 artifact 证明一条同病例组合工程链路，不是临床任务完成率、证据支持率、患者隔离或多病例稳定性成绩。

为检验 8 轮、两次 Encounter 的当前双臂执行，再运行 HCE-0001 adaptive 配对试点 [`20261011053401-70e94101`](../../artifacts/clinical-eval/runs/20261011053401-70e94101)，计划 16 条 arm-task record。single-agent 的 8/8 任务记录完成；integrated 完成前 4/8 条，已落盘 12/16。开始第二 Encounter 的协作请求时，可用 RAM 降至 6.48 GiB，低于本机运行停止线。进程后续已中断并离线 finalize 为 `partial`；配对临床指标仍为 `blocked-unreviewed-cohort`，跨患者隔离为 `not-run`。这不是完整配对结果，部分 scorer 报告的执行延迟不能冒充 8 轮双臂比较。

资源追查发现系统 Memory Compression 工作集约 13.38 GiB；旧 Python Health Engine 进程占约 9.66 GiB，另有本轮 Health Engine 约 9.68 GiB、既存 `llama-server` 约 4.30 GiB。只停止了本轮启动的 `8345/8346` bridge/Health Engine，保留旧 `8325/8333/8334` listener；停止后可用 RAM 回升至约 17.53 GiB，E 盘为 112.38 GiB。删除了本轮唯一 run-scoped synthetic memory 目录（321,813 bytes），部分 runs/review artifacts 保留。当前续跑风险是另一个旧 Health Engine 进程与本机其它服务叠加时的峰值内存；先恢复足够资源或确认可停止的旧进程，再续跑该 partial study，不启动 30 例批次。

## 18. JSONL 磁盘回读优化与 cap=2 组合 smoke

为避免每次启动 Health Engine 都将 823,450 条 chunk 的全文驻留 Python heap，`rag/corpus.py` 现在为 metadata/chunk JSONL 建立紧凑 byte-offset 表，并通过磁盘映射按命中行读取 chunk；仍在启动时逐行校验 JSONL 结构、ID 和 metadata 对应关系。索引格式、语料内容、检索排序与语义召回没有改动。Health Engine RAG 回归在本机现有 venv 中 **14/14 通过**，包含 FAISS 命中映射到真实 JSONL 行的集成 fixture；未安装依赖或下载数据。

随后使用当前工作树源码指纹 `fe025d59b70e5298d1038d5e4d4ede4beb590b5569054dc693746d431355a2c7`，在隔离的 `127.0.0.1:8345` GPT-6-Luna bridge（并发 cap=2）与 `127.0.0.1:8346` Health Engine 上重跑严格组合 smoke：[`smoke-20261011060033-97640497.json`](../../artifacts/clinical-eval/smokes/smoke-20261011060033-97640497.json) **passed**。同一 HCE-0001 Encounter 的 T06/T07 两个 root turn 均完成；T06 advanced DSH 协作 7/7 子运行成功、0 失败，child token 归因完整；T07 iterative RAG 两轮生成 4 个查询并检索 4 次，从 12 个候选中去重 6 篇、返回 3 条 StatPearls/PubMed evidence，未降级。另记录到单轮 RAG 返回 3 条 StatPearls evidence。AMA 5 次调用无失败，包含两次 commit、两次 recall 和一次成功的 session-end episode；memory cleanup 核验通过。Bridge 在 721 次采样中活动峰值 2、排队峰值 1、采样失败 0、attestation 未变化。总耗时 148.416 秒。artifact 不保留回答、患者消息或 evidence 正文。

优化加载器后的首次 cap=1 组合尝试保留为失败 artifact [`smoke-20261011055547-e5f1b5b1.json`](../../artifacts/clinical-eval/smokes/smoke-20261011055547-e5f1b5b1.json)：高级协作/RAG/AMA 子流程完成，但 child model calls 没有达到该严格 smoke 的真实并发门槛，且并发 observer 有失败采样，故没有判通过。改用 cap=2 后才得到上述通过结果；没有回写或放宽 cap=1 的验收结果。

资源方面，优化后的 Health Engine 启动工作集约 5.9 GiB，本次运行尾部约 8.3 GiB；在旧的本机 listener 保持不动时，可用 RAM 最低观测约 9.7 GiB，仍高于 8 GiB 停止线。停止本轮服务后恢复到约 18.8 GiB；E 盘可用约 112.4 GiB。本轮仅删除了对应的精确 run-scoped AMA 目录，没有触碰其它数据或服务，也没有下载模型、语料、索引或依赖。

该结果确认一条严格门槛下的两回合 **工程链路**，不能给出临床完成率、证据支持率、病史召回准确率或多病例稳定性。先前 partial 双臂运行绑定的是旧源码指纹，不能在新指纹下续跑；记录 §18 时新的 8 任务双臂运行尚未启动，随后完成的新 run 见 §19。旧 listener 与本轮 Health Engine 同时驻留时，本 smoke 的 RAM 余量只有约 1.7 GiB 高于停止线；development cohort 的 30 例仍待 reviewer 批准，临床指标继续保持 blocked。本记录不替代盲审或 adjudication。

## 19. 优化加载器后的完整单病例双臂纵向试点

为验证优化源码能否承载完整双臂，而不恢复或改写旧指纹的 partial run，先生成只读计划 [`plan-20261011-first-development-paired-lazy-corpus.json`](../../artifacts/clinical-eval/plans/plan-20261011-first-development-paired-lazy-corpus.json)：development split 1 个合成病例、8 个任务/臂、single-agent 与 integrated 两臂、adaptive follow-up 上限 1；GPT-6-Luna/codex-app-server、bridge cap=2、Health Engine/AMA 源码 SHA、Qwen3-Embedding-0.6B、RAG 和 recall isolation 均 attested，`preflightBlockers=[]`。计划明确显示所选病例未获临床 reviewer 批准。

随后从头完成 [`20261011060815-4f617d21`](../../artifacts/clinical-eval/runs/20261011060815-4f617d21)：16/16 条任务记录均完成，single-agent 8/8、integrated 8/8、0 个 execution failure/cancellation。配置为每病例串行、adaptive follow-up 上限 1、AMA 每 4 轮批量提交、最大输出 384 tokens；总耗时约 15.3 分钟。integrated 调用 `consult_clinical_team` 5 次、`search_medical_evidence` 1 次；DSH Agent Tree 记录 968,113 input / 7,637 output tokens，其中 24/24 直接 child sessions 的用量归因完整（604,513 / 4,743 tokens）。AMA 报告记录 10 次 model calls、220,792 prompt / 1,096 completion tokens、0 个失败操作；两次 automatic recall trace 均完成，召回 itemCount 合计 17。一次 root `search_medical_evidence` 调用 single-mode 本地 RAG，返回 3 条 evidence、未降级，P95 496.5 ms；本双臂 run 没有启用 iterative planner。

离线 `isolation-probe --synthetic-only=true` 通过：两个 run-scoped synthetic AMA namespaces 各自匹配自己的 canary，cross-patient canary leak=false，双方清理均 `verified`。随后以该 probe 重新 `finalize`，报告为 `memoryIsolation=passed`、16 个 blinded review packets；临床指标仍为 `blocked-unreviewed-cohort`，`pairedTaskCompletionDelta=null`，human-adjudicated runs=0。两臂 8/8 是工程执行完成率，不能写成临床任务完成率，也不构成 `76.3% → 93.1%` 的复现。

该 run 的每轮时延 P95 为 baseline 11.998 秒、integrated 180.010 秒；这是单一合成病例、384-token 输出边界下的 8 个 turn/臂观测，集成路径的协作调用明显增加了耗时，不是线上 SLA。运行期间 Health Engine RSS 峰值约 8.3 GiB、最低可用 RAM 约 11.3 GiB；结束并停止本轮 8345/8346 服务后可用 RAM 约 22.3 GiB。E 盘空闲维持约 112.4 GiB；没有下载或构建语料/模型/依赖。只删除了本次 run-scoped AMA 目录，review packet、manifest、逐轮记录和 score report 保留。

## 20. cap=4 协作/RAG smoke 与恢复后纵向集成试点

继续沿用现有本地 Luna bridge 与 Health Engine，没有下载、安装或重建模型、语料、索引或依赖。只读预演 [`plan-20261011-hce1-integrated-cap4.json`](../../artifacts/clinical-eval/plans/plan-20261011-hce1-integrated-cap4.json) 的 `preflightBlockers=[]`。GPT-6-Luna bridge 设 cap=4，Health Engine 使用 Qwen3-Embedding-0.6B；服务仅监听本机回环端口 `8345/8346`。

严格 smoke [`smoke-20261011063110-226f283a.json`](../../artifacts/clinical-eval/smokes/smoke-20261011063110-226f283a.json) **通过工程门槛**，总耗时 134.990 秒。高级 DSH/MDT 协作 7/7 child 成功、无降级；bridge 656 次采样无失败、attestation 未变化，活动峰值 3/4、排队峰值 0。RAG 同一次 smoke 实际覆盖 single 与 iterative 两路：iterative 两轮生成 4 个查询、执行 4 次召回，从 12 个候选聚合为 6 篇文档并返回 3 条 evidence，未降级；AMA 5 次模型调用无失败，包含 2 次 commit、2 次 recall 和 1 次 session-end episode。该 smoke 是链路/并发工程观察，不是回答质量或临床成绩。

随后运行 [`20261011063352-3a308f72`](../../artifacts/clinical-eval/runs/20261011063352-3a308f72)：HCE-0001 integrated-only、adaptive 模拟、8 轮、每轮最多 1 次患者追问、病例串行、AMA 每 4 轮提交、最大输出 384 tokens。首轮运行 T01 遇到 `MODEL_FAILURE` / provider `SERVER`；按现有 resume 语义恢复时，会重跑整组 case-arm 并把先前 8 条记录移入 `attempt-history.jsonl`，不会仅重放失败 turn。恢复后 T01 完成，但 T02 再次以 `MODEL_FAILURE` / `SERVER` 失败；当前 manifest 为 `partial`，当前 7/8 完成，不能报告 8/8 端到端完成率。恢复后的记录 P50/P95 为 32.59/122.17 秒；DSH 612,353 input / 5,478 output tokens（其中 child 326,511 / 2,477）；AMA 10 次调用、218,368 prompt / 1,096 completion tokens、0 个失败操作；一次 single RAG 返回 3 条 evidence，延迟 1,146.1 ms。`attempt-history.jsonl` 保存了首次尝试，不能把两次尝试合并为一次成功运行。

[`isolation-probes.jsonl`](../../artifacts/clinical-eval/runs/20261011063352-3a308f72/isolation-probes.jsonl) 的 synthetic AMA namespace 探针通过：患者 A/B own recall 均匹配，cross-patient canary leak=false，双方清理 verified。最终 score report 的 memory isolation 为 `passed`，但 cohort 仍未获批准、人工 adjudication 为 0，临床任务差值仍是 `blocked-unreviewed-cohort` / `null`。探针不验证患者身份授权、Gateway/SSO 或生产环境隔离。

300 例合成 cohort 的既有 [`coverage audit`](../../artifacts/clinical-eval/cohort-300-adaptive-v2.coverage.json) 状态为 `valid-synthetic-cohort`：300 patients、2,400 turns、2,425 facts，development/validation/held-out 为 30/75/195，当前 300 例全部 `pending`。development 的 [`blind review packet`](../../artifacts/clinical-eval/reviews/development-v2-review-packet.json) 已有 30 cases、240 turns、213 facts，要求 licensed clinician 审核；它是可交接的评测材料，不是模型评分结果或批准记录。

本轮可用 RAM 监测读数始终高于 8 GiB 停止线；停止本轮服务后 RAM 可用约 18.6 GiB，E 盘余量约 112.4 GiB。已确认 `8345/8346` 无 listener，只删除本轮唯一、路径核验过的 run-scoped AMA 目录（71,185 bytes）；评测 artifact 与 attempt history 保留。随后已为 bridge 的 malformed structured response 增加一次有界重试；provider `SERVER` 的总体原因仍未完全定位，改动的验证边界见 §21。

## 21. malformed structured response 的安全有限重试

§20 的失败记录促成了 [`codex-app-server-bridge.ts`](../../services/demo-gateway/src/backends/codex-app-server-bridge.ts) 的窄范围改动：Codex app-server turn 以 `failed/error` 结束，或返回不能通过严格 DSH response schema 解析的结构化响应时，bridge 最多用新的 ephemeral thread 重放一次相同 DSH transcript。`interrupted/refusal`、调用方取消和其他错误不重试。DSH host tool 仅在 bridge 返回被验证的结构化结果后执行，因此重放不会重复执行 `consult_clinical_team`、RAG、AMA 等 host-side 工具。

验证：[`codex-app-server-bridge.test.ts`](../../services/demo-gateway/tests/codex-app-server-bridge.test.ts) 定向测试现为 13/13 通过，覆盖 malformed response 与 provider turn 各自首错恢复、二次失败计数，以及 HTTP `/healthz` 只输出结构化数值 retry counters；`pnpm --filter @huiyi/demo-gateway build` 和仓库 `tsconfig.test.json` 类型检查通过。真实 Codex app-server 上没有强制制造故障，不能据此断言 live provider 的 retry 恢复率或 `SERVER` 故障率已下降。

## 22. 修复提示后的 cap=4 live smoke 与完整 8 轮集成复跑

先在初版有限重试代码下重跑严格 live smoke [`smoke-20261011065952-ffb863e5.json`](../../artifacts/clinical-eval/smokes/smoke-20261011065952-ffb863e5.json)：HCE-0001-T06 在首个 root model call 以 `MODEL_FAILURE/SERVER` 失败，bridge 仅记录脱敏类别 `invalid_model_response`；未进入 MDT、RAG 或 AMA completion。该失败 artifact 保留。随后为 malformed-response 的第二次 ephemeral thread 加入 schema 修复提示，并以 fake app-server 覆盖首错/次成功路径，避免用真实模型注入无效响应。

修复提示后的 live strict smoke [`smoke-20261011070124-735d5af6.json`](../../artifacts/clinical-eval/smokes/smoke-20261011070124-735d5af6.json) **通过**：T06/T07 两个 root turn completed；advanced MDT 7/7 child 完成、0 失败、token attribution 7/7；bridge cap=4、活动峰值 3、排队峰值 0，669 次采样无失败；single RAG 返回 3 条 StatPearls evidence，iterative RAG 2 轮、4 queries/4 recalls，从 12 candidates 聚合 9 篇文档后返回 3 条 PubMed/Textbooks/StatPearls evidence，均未降级。AMA 5 次模型调用无失败，两次 commit、两次 recall、session-end 生成 1 个 episode；namespace cleanup 通过。总耗时 138.6 秒。此 smoke 没有报告失败，但也没有显示是否触发过透明重试。

随后使用同一当前 bridge/Health Engine 路由完成 [`20261011070755-c122cfe3`](../../artifacts/clinical-eval/runs/20261011070755-c122cfe3)：HCE-0001 integrated-only、adaptive follow-up cap=1、8 planned turns、病例串行、AMA 每 4 轮批量提交、384-token 输出上限；`manifest.sourceFingerprint.sourceSha256=b3fe37f28bc81bd60492517de1c7192ab018266a1c41d68999763c3002b1525a`。8/8 execution completed、0 失败/取消；11 次 root assistant exchanges、3 次合成患者追问、2 次协作工具调用/12 个 child sessions、0 个 failed child，child token attribution 完整。DSH 共 602,312 input / 5,736 output tokens（child 313,757 / 2,836）；AMA 10 次模型调用、222,641 prompt / 1,471 completion tokens、0 failed operations；single RAG 1 次返回 3 条 evidence，747.6 ms，无降级。turn P50/P95 为 15.97/120.33 秒。与 §20 的 partial run 相比，这次当前源码复跑完成 8/8；仍是单一合成病例的工程稳定性观察，不能外推为总体可靠率或临床完成率。

本 run 的 reviewer/adjudication 为 0/8，`pairedTaskCompletionDelta=blocked-unreviewed-cohort` / `null`；本次 score report 的 memory isolation 是 `not-run`，不能把 §19/§20 的独立 AMA namespace probe 当作本 run 的探针。由于运行末 RAM 降至约 8.65 GiB，达到完整落盘后立即停止 `8345/8346`，未叠加额外 probe；停止后 RAM 回升到约 18.9 GiB、E 盘余量约 112.4 GiB。已删除本次精确 run-scoped AMA 临时目录（61,221 bytes），端口无 listener；运行 artifacts 均保留。没有下载模型、语料或依赖。

## 23. bridge 重试计数与 smoke 运行差值

为让下一次 strict smoke 能区分“没有遇到可重试故障”和“重试后恢复”，Codex bridge 的 loopback `/healthz` 现在附带进程生命周期计数：重试尝试、成功、失败，以及 malformed-response/provider-turn 两类尝试。计数器不含输入、输出、患者资料、thread/session 标识；smoke 启动前读取基线，运行停止后再取最终值，artifact 写入两者与差值。smoke schema 升至 v6；若当前 bridge 进程不提供新字段，会在模型请求前要求用当前源码重启 bridge，避免产生缺遥测的 strict 样本。

此遥测改动已由 13 项定向 bridge 测试、Gateway build 和仓库类型检查验证。§22 的 cap=4 smoke 和 8 轮 E2E artifact 早于本次改动，没有 retry-counter 差值，不能回填成 `0 retries`。新版本 strict live smoke [`smoke-20261011072415-002cc43c.json`](../../artifacts/clinical-eval/smokes/smoke-20261011072415-002cc43c.json) 首次记录到一次真实运行期重试：baseline 为 0，final 为 attempts=1、successes=1、failures=0、malformedResponse=1、providerTurn=0。它是结构化输出解析失败后的新 ephemeral thread 重试成功，不是 app-server `SERVER` turn error 恢复率。

这条 smoke 的 2/2 root turns 完成、总耗时 147.908 秒；高级协作 7/7 child completed、0 failed，DSH root/child 合计 219,211 tokens，子 Agent 141,123 tokens 且归因完整；single 与 iterative RAG 均非降级，各返回 3 条 evidence，iterative 为 2 轮/4 次检索/2 次 planner call，命中 PubMed 与 StatPearls；AMA 5 次模型调用、两次 commit、两次 recall、1 个 session-end episode，synthetic namespace cleanup verified。bridge 并发峰值 2、排队峰值 1，713 次采样无失败。该样本验证的是这一个短工程链路，不是总体成功率或临床结果。

启动时发现旧 `8326/8335` listener 已存在，读取了健康信息但未停止、重启或向其发送生成请求；当前代码在独立 `8347/8348` 运行，结束后只停止本轮 listener。运行前可用 RAM 约 12.9 GiB，期间抽样读数约 12.0–12.4 GiB，结束附近读数约 9.5 GiB；没有观测样本低于 8 GiB，但采样不是连续监控。停止隔离服务后 RAM 回升至约 18.4 GiB。结束时 C/D/E 可用空间约 8.03/179.75/112.36 GiB，无模型、语料、索引或依赖下载。确认 8347/8348 已释放后，按已解析并限定在五源索引目录内的路径删除本轮唯一 synthetic AMA temp directory（47,048 bytes）；smoke JSON 与代码变更保留。

## 24. 评测工作台患者绑定回归与当前授权 sweep

`apps/demo-web/src/clinicalEvaluationWorkspace.test.tsx` 用真实 React 工作台、模拟 HTTP 和两名合成评测用户覆盖登录、患者切换、Encounter/服务端 Session 重建、提交咨询时绑定当前 patientId/encounterId/sessionId、生产评测请求不带 demo scenario，以及退出登录。完整 demo-web Vitest 为 9/9 通过；`pnpm exec tsc -p tsconfig.json --noEmit` 通过；`pnpm run build` 生成生产前端后，内置检查确认 5 个产物文件未包含 demo 文案或 seed 患者名。生产构建有一条 595 kB chunk 体积提示，不影响构建成功。Playwright 浏览器回归现在包括 mock API 的 [`clinical-evaluation.spec.ts`](../../apps/demo-web/tests/e2e/clinical-evaluation.spec.ts) 与真实 Gateway 的 [`clinical-evaluation-gateway.spec.ts`](../../apps/demo-web/tests/e2e/clinical-evaluation-gateway.spec.ts)，本机缓存 Chromium 1228 合计 2/2 通过。可用 [`clinical-browser-gateway-smoke.ps1`](../../scripts/eval/clinical-browser-gateway-smoke.ps1) 复现；脚本复用缓存浏览器，不下载浏览器。真实 Gateway 用例实际登录临时合成账号、读取 Gateway 返回的 75 个授权患者选项、切换患者并确认服务端 Session ID 更新、再退出登录。Gateway/Vite 仅绑定 loopback；用例不调用 `/api/chat`、Health Engine、DSH 或模型，只覆盖浏览器到真实 Gateway 的登录、患者列表和会话生命周期，因此不是生成回答的浏览器 E2E。

当前 worktree 的授权 sweep [`authz-sweep-20261011-154507.json`](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261011-154507.json) 绑定 revision `492595785b61ab795e60588212997a646a805aa2`、相关源码 SHA-256 指纹 `c869d5e26976ff753af181e103d5f780858f60c85a87c8ca6080f782ba5a949a`（相关源码处于 dirty worktree）。隔离 Gateway 在 `127.0.0.1:8350` 启动，GPT-6-Luna route attestation 成功；2 个同 tenant、不同 access group 的一次性合成账号对 300 个合成患者的 600 次上下文读取中，150 次授权成功、450 次越组读取均为 404、未授权成功 0、意外状态 0；上下文读取 P95 为 2.59 ms。跨账号删除 Session 为 404、所有者删除为 204；登出后患者列表均为 401。Gateway 生成模型请求数为 0，sweep 耗时 2,854.61 ms；运行前后空闲 RAM 18.6 GiB、C/D/E 空间 8.0/179.8/112.4 GiB 均未见变化，8350 listener 已释放。

首次配置错误的诊断记录 [`authz-sweep-20261011-154353.json`](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261011-154353.json) 也保留：测试账号 B 被错误放入 tenant-2，与 sweep 对 tenant-1 两 cohort 的预期不一致，因此该次输出 `fail` 不能当作授权越权发现或通过测量；改正临时账号后以上一份同源码指纹的 `pass` 为有效结果。

已完成的浏览器模型回合覆盖本机合成数据与当前源码路径，不能证明真实 EMR、生产 OIDC/SSO、数据库行级安全、临床安全或公网入口。它只是一条浏览器生成链路，不是 300 例 × 8 轮模型 E2E。300 例均 pending、批准数为 0；临床任务/证据/记忆正确率必须等待病例批准和盲化 adjudication，不得由 turn completed、授权请求数或 UI 测试替代。


## 25. 300 例只读预检与真实浏览器模型回合

旧的本机 listener 8325/8333/8334 保持不动。用其现有服务做全量 plan-only 时，模型可达，但 route attestation 因旧 bridge 不报告 bounded concurrency、Health Engine 源指纹缺失且 AMA/planner endpoint 与所选 bridge 不同而 mismatch；记录在 [旧服务预检](../../artifacts/clinical-eval/plans/plan-20261011-all-300-paired-preflight.json)。随后只在空闲 loopback 端口 8355/8356 启动当前 worktree GPT-6-Luna bridge 与 Health Engine：bridge 上限 2，Health Engine source SHA 与当前代码一致；RAG status 为 ready，Qwen3-Embedding-0.6B 连接五源、823,450 段索引。重新生成的 [当前源码全量计划](../../artifacts/clinical-eval/plans/plan-20261011-all-300-paired-current-source-preflight.json) 覆盖 300 例、2,400 个 patient-task turns、600 个 case-arm tasks；adaptive follow-up=1 时最多 9,600 次 root-agent exchanges；route preflight blockers 为 0。该命令没有生成或向量检索，且 300 例临床审核仍 pending，clinicalMetricGate.selectedCasesApproved=false。

随后对一个合成患者实际执行 Playwright 浏览器模型回合：[脱敏 E2E 结果](../../artifacts/clinical-eval/browser-e2e/browser-e2e-20261011-162202-0b478c03.json)。浏览器登录隔离 Gateway、读取 75 个授权患者选项、切换患者并创建新服务端 Session；POST /api/chat 为 200，GPT-6-Luna DSH 回合完成，实际完成 search_medical_evidence 并回传 3 条本地 evidence，检索编码器是 Qwen3-Embedding-0.6B。单次浏览器请求耗时 35,421 ms，不能解释为 P95 或临床指标。报告仅记录状态、计数、模型/索引版本和耗时，不落患者提示、回答或证据正文。该浏览器 artifact 没有 AMA 调用计数；AMA 跨轮读写和隔离仍引用既有 clinical-eval run artifact，不能从此单回合 browser 测试推断。

复现当前预检需先在 loopback 端口启动当前源码 bridge 与 Health Engine，再运行：

    $env:HUIYI_DEMO_MODEL_BACKEND="codex-app-server"
    $env:HUIYI_DEMO_CODEX_MODEL="gpt-6-luna"
    $env:HUIYI_CODEX_BRIDGE_URL="http://127.0.0.1:8355/v1"
    $env:HUIYI_CODEX_BRIDGE_API_KEY="local-only"
    $env:HUIYI_HEALTH_ENGINE_URL="http://127.0.0.1:8356"
    pnpm --filter @huiyi/demo-gateway clinical-eval -- plan --cohort=artifacts/clinical-eval/cohort-300-adaptive-v2.jsonl --split=all --limit=300 --arms=both --patient-simulation=adaptive --patient-followups=1 --synthetic-ama-memory=true --max-tokens=384 --output=artifacts/clinical-eval/plans/plan-20261011-all-300-paired-current-source-preflight.json

只做一次真实 Gateway UI 生成回合可执行：

    ./scripts/eval/clinical-browser-gateway-smoke.ps1 -GatewayPort 8357 -WebPort 8358 -BridgePort 8355 -HealthEngineUrl http://127.0.0.1:8356 -RunModelChat

脚本使用已缓存 Chromium，不下载浏览器。-RunModelChat 会发起模型生成；默认模式只测认证与 session，不调用模型。此次临时 8355–8358 listener 均已释放；run-scoped AMA 数据目录已删除 84,207 bytes；RAM 从服务停止前约 9.43 GiB 回到约 18.15 GiB，C/E 可用空间保持约 8.01/112.36 GiB。没有下载模型、数据、依赖，也没有重建索引。

## 26. 2026-10-11 M1 live browser E2E 资源故障

在 `4f12bc5` 的会话关闭修复后，尝试以 GPT-6-Luna 运行一轮真实浏览器到 Gateway/DSH/RAG 的合成 E2E，并扩展断言检查结构化复诊草稿、草稿中的医学证据以及“需补充问诊”的演示审核留痕。Playwright 启动了 2 个 worker；约 46.6 秒后其中一个 Node worker 报告 JavaScript heap out-of-memory，浏览器模型用例失败。基础 mock 浏览器用例通过，但不能据此宣称 live E2E 或草稿审核链路通过。测试没有生成新的脱敏成功结果，也没有进入/完成草稿审核断言；此次运行不纳入临床或工程成功率。

脚本报告失败并尝试关闭自己创建的 Gateway/Web listener，诊断日志保留于本机临时目录。之后用户反馈电脑黑屏并重启；现有证据确认同一时段发生了 Playwright worker OOM，但不能据此断定它是整机黑屏的唯一原因。模型、语料和依赖均未下载；在本次执行中未验证是否产生了新的草稿记录。不要将这次运行写成通过结果。

为避免相同的并发负载，live browser E2E 配置现在强制单 worker，并要求在启动 Gateway、浏览器和模型请求前至少有 24 GiB 空闲物理内存；Playwright 用例还会在提交模型请求前复核该下限。低于下限时应 fail closed，不自动重试或杀停其他进程。此防护尚未通过 live 模型运行验证；本轮故障后没有重新启动 live 测试栈。
