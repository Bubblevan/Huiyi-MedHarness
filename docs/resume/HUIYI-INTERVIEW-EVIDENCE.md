# Huiyi-MedHarness｜面试证据与口径

## 简历选用结论

B1 早期小样本结果已撤出简历和投递口径，不作为可主张的效果数字。新建的异构 300 例候选 cohort 尚待人工审阅，未运行模型，也没有新的 B1 效果结论。B3 使用公开长对话基准的 DSH 集成诊断结果作为工程指标；AMA-only 的独立试验未见正确事实回显提升，多专家能力试验也没有实际触发 child run，因此不写成组件级收益。所有保留的完成率、质量分数均来自合成数据或公开基准工程评测，不等同于临床验证。

## B1｜统一临床工作流：新候选 cohort，待人工审阅

- 候选数据：300 个合成纵向病例、2,400 轮任务、15 个工作流领域、300 个不同的病例维度组合；每例 2–4 次 FHIR Encounter。
- 覆盖维度：6 类纵向变化、6 类历史依赖、7 类资料完整性状态、5 类信息冲突状态、5 类风险信号；候选队列包含 99 例信息冲突和 61 例风险事件。
- 难度：easy 60 例、moderate 150 例、hard 90 例。难度代表预设的信息整合复杂度，不代表临床严重度。
- 状态：clinicalReviewStatus 全部 pending；没有模型运行或新效果评分。上述生成数量仅说明数据设计覆盖，不代表临床有效性或任务质量已获认可。
- Cohort SHA-256：`704ac38d51afaf755b41cc1ea95bb7fcc38cb5ffb846af4161cd1c52a3ea6b88`。逐例审阅见 `artifacts/clinical-eval/reviews/cohort-300-heterogeneous-v3-manual-review.csv`；说明见 `docs/eval/COHORT-300-HETEROGENEOUS-V3-REVIEW.md`。
- 早期试跑与评分原始工件保留在 `docs/eval/B1-SPRINT-002-RESULTS.*` 和对应 run 目录以供审计；不用于简历或面试效果主张，也不跨版本拼接。

## B2｜医学 RAG

- 固定开发集：10 个病例各 1 个 T07 循证任务，共 10 对、20 次生成；GPT-6-Luna，关闭记忆和协作，仅切换 RAG。
- 任务满足率：无 RAG 1/10（10%），RAG 10/10（100%），+90 个百分点；RAG 独赢 9、无 RAG 独赢 0、平 1。RAG 臂 9/10 任务检索到段落，29/29 个回答引用 ID 匹配同轮检索记录。
- 索引：medtext-local-cc7d43568501e6b7，5 个来源、823,450 chunks，Qwen3-Embedding-0.6B。28 条评分可见的医学/工作流主张中，25 条直接支持、3 条部分支持、0 条不支持、0 条矛盾；4 份评分副本移除了末尾来源列表，主张支持结论仅适用于评分副本的可见内容。
- 限制：盲化模型辅助工程评分，不是临床审核；10 对 development 结果不外推到 held-out。引用 ID 可追溯不等于结论正确。较早的 6 条错误配置试跑已标为 invalid-protocol，不计入上述结果。

## B3｜长期记忆与跨会话上下文

- 选用工程指标：HC-MEM-003 公开 LoCoMo mc10 长对话记忆诊断。只取数据集中 3 段完整对话（conv-26、conv-30、conv-41），共 1,451 个对话项目、385 道非 category-5 QA；category 5 的 112 题排除。不是完整 10 对话基准结果。
- DSH C 臂：真实 DSH Session、Agent、AgentLoop 加 Huiyi 自动记忆生命周期，Qwen3-8B 生成；Token-F1 0.4408、BLEU-1 0.3860、解析错误 0。与 sidecar B 臂比较，差值分别 +0.0022 和 +0.0042，均在预设 ±0.01 总体容差内。
- 集成一致性：385/385 题 MemorySnapshot 一致、385/385 题来源引用一致；782/792 条记忆来源引用有效（98.74%）。本次 QA 每题一次自动召回、一个模型步骤；没有 tool call 或 memory write。结果证明这批诊断样本上的 DSH 集成和来源一致性，不证明 AMA 带来回答质量提升。
- 可比性限制：未评其余 7 段对话；没有跑论文所用 GPT-4o-mini judge，禁止与论文 Token-F1 0.510 / BLEU-1 0.432 作等价比较。A→B BLEU-1 差 -0.01128，略越过 0.01 容差；仅作为诊断备注。
- AMA-only 失败实验：3 例、6 个配对目标轮、12 个历史事实机会；两臂精确事实回显均为 0/12，T05 目标事实 ID 命中均为 0/6，AMA 臂有 1 次超时。该结果不支持记忆收益，不能包装成正向提升。
- 协作失败实验：6 个病例、14 个冻结关键点；Single 覆盖 8/14，Integrated 覆盖 3/14，Integrated 有 5 次超时。两臂协作工具调用与 child run 均为 0，因此没有测到实际多专家协作效果。BOSS 正文不写成协作收益。

## B5｜边缘门户与患者级权限

- 本地授权 sweep：300 个合成患者、600 次患者/Encounter 上下文检查，授权读取 150、拒绝 450，越权成功 0；上下文只读 P95 2.59 ms。
- 本机 Docker Compose 浏览器链路：HTTPS 前端、edge-auth、仅监听 loopback 的 Gateway、DSH、GPT-6-Luna 本地 Codex bridge 与本地 RAG。1 次真实模型请求返回 HTTP 200，展示 3 条证据、生成结构化草稿并留下“需补充问诊”审阅状态；46.623 秒端到端，SSE 首包 77.8 ms。未执行临床批准。
- 边缘 API：并发 20 时 20/20 成功；跨账号患者上下文和跨患者会话返回 404，Gateway 不可达时代理返回 502。20 并发结论限于本机本次合成 API 压测。
- 未验证：公网 DNS/ACME、VPS、真实 WireGuard 隧道、生产 SSO、持久授权存储、真实 EMR 与公网延迟；因此只表述为本机原型与本地授权检查，不声称公网生产部署或完整私有化生产交付。

## 后训练

待实际训练、独立评测和可复核结果后填写；本版不写后训练成绩。

## 证据文件

- B1 冻结结果与逐任务判定：[B1-SPRINT-002-RESULTS.md](../eval/B1-SPRINT-002-RESULTS.md)、[B1-SPRINT-002-RESULTS.json](../eval/B1-SPRINT-002-RESULTS.json)、[B1-SPRINT-002-per-task-cost.json](../eval/B1-SPRINT-002-per-task-cost.json)
- B2 配对结果：[RESUME-B2-FINAL.md](../eval/RESUME-B2-FINAL.md)、[RESUME-B2-FINAL.json](../eval/RESUME-B2-FINAL.json)
- B3 隔离评测：[RESUME-B3-FINAL.md](../eval/RESUME-B3-FINAL.md)、[RESUME-B3-FINAL.json](../eval/RESUME-B3-FINAL.json)
- B3 长对话诊断：[final-report.md](../../artifacts/hc-mem-003/three-conversation-diagnostic/final-report.md)、[aggregate-metrics.json](../../artifacts/hc-mem-003/three-conversation-diagnostic/aggregate-metrics.json)、[manifest](../../eval/memory/locomo/manifest-hc-mem-003-three-conversation-diagnostic.json)
- B5 本机验收：[部署说明](../../deploy/edge-demo/README.md)、[浏览器链路结果](../../artifacts/edge-demo/local-e2e-result-20261012.json)、[授权 sweep](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261011-154507.json)
