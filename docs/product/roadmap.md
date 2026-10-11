# Huiyi MedHarness 产品路线图

**原则：** 先让一次复诊的临床工作流可完整评测，再交付明确标注的合成演示；真实患者接入需要独立身份、患者/Encounter 授权和审计验收。当前只有本机合成数据验证，不对真实临床效果作承诺。

## P0 — 完成临床业务闭环

- 打通受信患者身份与当前 Encounter 上下文读取；只加载当前主体有权访问的患者和就诊。
- 覆盖初诊到复诊连续流程：读取历史资料、发现缺项并提问、按需检索证据、总结病情变化、形成医生审核草稿。
- 明确 AMA patient memory、RAG 外部医学证据、MDAgents-derived 子运行和 DSH root turn 的边界；证据与患者历史始终分开。
- 加入取消、恢复、失败、同一患者并发 Session、跨患者隔离和审计事件验收。
- **验收状态：** 当前生产 EMR/患者授权适配、医生审核/写回闭环尚未在本仓库实现；上线前不得把本项标记为完成。

## P0 — 建立统一合成患者任务评测

- 按[统一临床任务评测 PRD](../eval/unified-clinical-task-evaluation-prd.md)运行单 Agent 对照、集成基线和后续后训练实验组。
- 先 30 名患者调试，再 60–80 名验证，最后扩展到约 300 名并保留独立冻结测试集。
- 以复诊任务完成、病史召回、证据支持/引用、风险识别、患者隔离、调用成本和端到端 P95 汇报；高风险漏报单列。
- **验收状态：** 旧 GPT-6-Luna 配对诊断已保留为故障记录（integrated AMA 8/8 `OperationalError`）。修复后另完成 HCE-0001 单例 8 轮集成链路：8/8 DSH 回合完成、两段 Encounter 各写入一次 AMA、第二段首次自动召回 8 个记忆项、RAG 返回 3 条证据、协作 7 个子运行无失败；AMA 共 10 次调用，清理后 namespace 计数为零。范围受限的本地 AMA namespace 隔离探针通过。usage 观察器在 1-child smoke 收到 18,368 tokens；5-child 尝试精确对上 5/5 Sessions、101,500 tokens，但 root 失败；随后一轮 T06 又在约 20 秒以 `SERVER` 失败。bridge 重启后，同一 T06 单轮 smoke 完成 6/6 协作子运行（0 失败、未降级），准确归因 6/6 Sessions 和 189,878 DSH tokens，AMA 提交/清理通过，耗时 123 秒。此后又完成一例 T06 单轮安全 smoke（1/1 child、RAG 遥测 1/1、AMA 清理通过，46.104 秒）；仍只是单例链路，不是临床成绩。2026-10-11 已生成 v2 cohort 的聚合覆盖审计：30/75/195 split，development 覆盖 12 个场景族、14 basic/16 complex；300 例仍全部待临床审核。新增 `clinical-eval plan` 只读预演，development 30 例、两臂 adaptive（每轮最多 1 次跟进）对应 960 根 Agent 交互上限；桥接健康、Health Engine 健康/路由、AMA 与 planner 的 GPT-6-Luna 路由、Qwen3-Embedding-0.6B 和 AMA recall 隔离均通过只读 attestation，预演不发生成请求、不执行检索。评测 `run`/`resume` 已固定拒绝非 Codex app-server GPT-6-Luna 配置，避免空环境回落至 Qwen3-8B。另已为阶段 A 导出 30 个 development 档案 review packet（240 轮、213 个临床事实；隔离 canary 被排除，reviewer 仅见别名，case ID crosswalk 留在 Git 忽略的 private artifacts）；该包仍全部待审。**病例未人工盲审，配对 30 development 阶段尚未运行**；临床指标仍锁定。审批通过后再按本机预算启动分阶段调试，之后做 60–80 例验证。

2026-10-11 后续 bounded bridge 工程 smoke 通过显式路由调用了 DSH 协作工具，并实测最多 2 路 child model request 同时活动；同一次 advanced 协作中 6 个 child 有 1 个失败，结果为 degraded。脚本与证据清单已保留该失败，不把它合并成前述无降级样本或临床成功率。

当日当前 worktree 又完成一条组合 smoke：HCE-0001 高级协作 7/7 child 成功、iterative RAG 两轮返回 3 条 PubMed evidence、AMA 生成首个 episode、路由与 token 遥测完整；详情见[评测 runbook §17](../eval/clinical-evaluation-runbook.md)。随后启动 HCE-0001 八轮双臂 adaptive 纵向试点，完成 single-agent 8/8 记录和 integrated 4/8 记录后，因可用 RAM 低于 8 GiB 安全线而中断；该运行已 finalize 为 partial，临床评分仍 blocked。300 例 cohort 审核和 blind adjudication 未完成，因此不报告复诊任务提升、病史/证据质量或临床效果。续跑前需解决本机 RAM 峰值并保留原 cohort、模型与运行配置。

之后为 RAG chunk JSONL 增加磁盘按需读取与紧凑 offset 表，降低 Health Engine 启动驻留；RAG 定向测试 14/14 通过。在优化后工作树上以 cap=2 再次通过 HCE-0001 T06/T07 严格组合 smoke：advanced 协作 7/7 child 成功、两轮 iterative RAG 返回 3 条 StatPearls/PubMed evidence、AMA recall/commit/session-end 均完成且无失败，721 次 bridge 采样无丢失，详见[评测 runbook §18](../eval/clinical-evaluation-runbook.md)。运行中 Health Engine 工作集约 8.3 GiB，RAM 最低余量约 9.7 GiB；在 §18 记录时，旧 partial 的源码指纹已过期，新的长程配对试验尚未运行，且 30 例审核未完成。临床指标仍 blocked；随后完成的新试点见下文。

随后使用优化源码与 attested Luna route 完成新的 HCE-0001 双臂、8 轮/臂 adaptive 试点：16/16 任务 execution completed，0 失败；集成臂 24/24 child sessions 用量归因完整，AMA 10 次模型调用无失败，local single RAG 检索 3 条 evidence。run-scoped synthetic AMA 双 namespace 隔离探针 pass，跨 namespace canary 泄漏 0、清理均验证；完整分臂统计与资源记录见[评测 runbook §19](../eval/clinical-evaluation-runbook.md)。临床 reviewer/adjudication 仍为 0，因此 paired clinical delta 继续为 null；单病例工程完成率不能替代临床成效指标。

最新 cap=4 工程 smoke 又验证了同一 Gateway/DSH 路径中的 7/7 advanced child、iterative RAG 两轮/4 查询、AMA commit/recall/session-end 及 bridge 峰值 3/4；初版 retry 下的纵向恢复 run 曾为 7/8 并有 provider `SERVER` 失败，已保留为 partial 记录。随后 bridge 加入 malformed-response schema 修复提示，fake app-server 集成测试验证一次失败后第二个 ephemeral thread 可按修复提示恢复（11/11 定向测试、Gateway build 通过）；修复后的 strict live smoke 通过，当前源码下另完成 HCE-0001 integrated-only 8/8 纵向工程 run、0 execution failure。其 P95 为 120.33 秒，详情见[评测 runbook §21–22](../eval/clinical-evaluation-runbook.md)。这是单病例工程复跑，不代表线上可靠率或临床指标；当前 reviewer/adjudication 仍为 0，临床指标仍 blocked，300 例 cohort 全部待审。

随后为 Codex bridge 增加脱敏 retry counters，并由 strict smoke 记录 run 前后计数差值；fake app-server 覆盖 malformed/provider 两类重试、成功/失败结果和 `/healthz` 输出，13/13 定向测试、Gateway build、仓库 TypeScript 检查通过。新版本两轮 integrated strict smoke 在隔离端口首次实测 malformed-response retry 1 次且恢复成功；高级协作 7/7、iterative RAG 2 轮/4 次检索、AMA 五次调用与清理均通过，耗时 147.9 秒，见[评测 runbook §23](../eval/clinical-evaluation-runbook.md)。此前 8 轮样本早于遥测实现；这仍是一个工程样本，不代表总体可靠率或临床成绩。运行后关闭本轮服务，RAM 回升至约 18.6 GiB；旧 `8326/8335` listener 未停止或重启。

## P1 — 发布公开合成演示

- 在 2 vCPU / 2 GiB Ubuntu 门户主机部署 HTTPS 前端、轻量 Gateway、限流和轻量登录/访问门槛。模型权重、MedCPT、FAISS/Milvus 和医疗语料不放到门户机。
- 使用 WireGuard 私有通道连接本地 GPU 侧推理与知识服务；门户只通过受控隧道访问，服务绑定内网/隧道接口。
- 演示帐号只访问明确标注的合成患者；不允许真实患者、EMR、真实 AMA memory 或临床记录写回。
- **放行条件：** HTTPS、身份隔离、限流、断线恢复、日志脱敏、隧道不可达时 fail-closed 和合成数据标识通过测试。

## P2 — 真实患者/机构接入（单独治理项目）

- 接入机构 OIDC/SMART-on-FHIR 或经机构批准的身份服务；服务端验证医生、患者、Encounter 与组织范围授权。
- 建立最小必要的数据访问、患者级 memory namespace、审计查询、保留/删除策略和医生确认工作流。
- 在隐私、安全、临床治理和机构 IT 验收前，真实患者聊天、记忆读取和临床写回保持关闭。

## P3 — 基于失败轨迹的模型迭代

- 仅从经过审核、用途许可且能追溯来源的失败轨迹构造训练/验证数据；患者/提示/答案隐私策略先行。
- 先证明训练环境 canary 和保存/加载可复现，再冻结 SFT 或 RL 候选，并在不泄漏测试集的前提下做配对评测。
- 当前 LoRA/QLoRA canary 未执行，veRL/RL 环境也未验证；不宣称训练增益，不阻塞先完成工作流和评测。

## 交付状态规则

每项功能仅标为“已实现且有证据”“部分实现”“待实现/阻断”。本地 fixture、有限合成 E2E、论文结果和待办计划分别记录，不互相替代。详细证据与可用于简历的表述见[项目经历与证据清单](./evidence-backed-project-profile.md)。
