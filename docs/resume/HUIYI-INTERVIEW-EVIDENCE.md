# Huiyi-MedHarness｜面试证据与口径

## 简历选用结论

BOSS 主结果采用 B1 最新完整冻结版本（5 例、40 对），B1 旧版本（6 例、48 对）只保留为独立历史结果，不跨版本拼接。B3 使用公开长对话基准的 DSH 集成诊断结果作为工程指标；AMA-only 的独立试验未见正确事实回显提升，多专家能力试验也没有实际触发 child run，因此不写成组件级收益。所有完成率、质量分数均来自合成数据或公开基准工程评测，不等同于临床验证。

## B1｜统一临床工作流：BOSS 主结果

- 选定运行：20261011184053-5bce7818，GPT-6-Luna，经 Codex app-server；冻结运行源码 0c7ddc93df99cbe92cc4ac4b25ba34c933e376b0，source SHA-256 18190a8bc8a597664ed0f4eddf475dc264d6baa958815d915c22618d0296156d。该源码提交是当前 main（c8b19df）的祖先。Cohort SHA-256 为 7d70893f2ffab9f8711f5ac260a1f70729bef758fb41f7cae50afaa894a6310c。
- 固定范围：HCE-0001 至 HCE-0005，5 个合成纵向病例、每例 8 轮，40 个同病例同轮配对任务。运行账本有 80 个唯一最终臂任务，Single 与 Integrated 各 40 条，均为执行完成；80 条评分记录覆盖这 40 对。关键任务的评分完成结果仍按每臂 40 个预定任务作分母。
- 主结果：Single 23/40（57.5%），Integrated 39/40（97.5%），配对净差 +40.0 个百分点；Integrated 独赢 16 对、Single 独赢 0 对、双方完成 23 对、双方未完成 1 对。
- 其他指标：已披露历史事实正确引用 Single 21/40（52.5%）、Integrated 36/40（90.0%）；合规结构化草稿两臂均为 10/10。延迟 P50/P95：Single 7.64/14.52 秒，Integrated 20.60/116.13 秒。观测 Token 总量分别为 969,356 与 2,705,573，不是货币成本。
- 失败留存：最终运行的 attempt-history 有 32 条先前尝试，其中 11 条成功、21 条失败（20 次 MODEL_TIMEOUT、1 次 AUTHENTICATED_GATEWAY_EXCEPTION）；之后对缺少的臂任务补跑，runs.jsonl 最终含 80 个唯一且成功执行的臂任务。112 次总尝试中 91 次完成、21 次失败，失败保留在历史中，不扩大配对任务分母。
- 清单解释：manifest 的 stopReason 保留了初次 64/80 时停止计分的描述；同一清单的 finalizedAt、completedTurns/completedRuns=80、runs.jsonl 的 80 个唯一记录及最终 score report 的 40/40 每臂共同表明续跑后完成了全部预定臂任务。该描述不代表最终只评了 32 对。
- 评分及限制：隐藏 A/B 标签的模型辅助工程评分，不是真人临床审核；临床审核仍 pending。医学证据 ID 在 Integrated 回答中有 24/48 可匹配同轮检索结果，但“医学证据是否支持结论”不可测。历史事实评分没有逐事实 AMA sourceId 命中记录，故 90.0% 不能归因于 AMA 单独效果；B1 是整体 Harness 组合比较。
- 旧版本单独留档：运行 20261011104158-f3ea4e2f、源码 492595785b61ab795e60588212997a646a805aa2、6 例/48 对；Single 26/48（54.2%），Integrated 32/48（66.7%），+12.5 个百分点。运行源码版本与纳入病例数不同；两次使用同一冻结 Cohort SHA，但分母不同，不与新版拼接或作跨版本因果比较。旧结果只用于解释历史演进，不是 BOSS 主数字。

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
