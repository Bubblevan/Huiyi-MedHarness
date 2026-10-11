# Huiyi-MedHarness｜简历项目经历快照（2026-10-12）

**定位草稿：** 医疗 Agent 工作流与本机工程验证。职务“系统开发负责人”和开发时间“2026.07–2026.10”来自用户提供的简历目标；具体个人职责仍需本人确认。

**项目介绍草稿：** 面向互联网医院复诊场景，构建基于 DeepSeek Harness 的临床 Agent 工作台原型，整合合成患者/Encounter 上下文、AMA 纵向记忆、本地医学 RAG、多专家协作及结构化复诊草稿流程；所有当前量化结果均来自合成数据或本机工程评测，不代表临床验证或生产服务质量。

## 当前可核实的技术栈

TypeScript、Python、DeepSeek Harness、GPT-6-Luna（Codex app-server）、Qwen3-Embedding-0.6B、FAISS、AMA、MDAgents-derived 协作。Qwen3-8B 当前 E 盘副本是 Q4 GGUF 推理权重；LoRA/GRPO 尚未训练。没有证据支持将阿里云、WireGuard 或生产 SSO 写作已完成部署。

## 五条 Bullet 的当前候选与状态

### 1. 临床 Agent 全链路

**状态：`INSUFFICIENT_EVIDENCE`。** 候选工程表述：

> 基于 DeepSeek Harness 打通合成患者/Encounter 上下文、医学工具调用、复杂病例协作、草稿生成与会话级状态管理；GPT-6-Luna 修复版在 31 个配对任务上，Integrated 关键任务完成 20/31（64.5%），Single 完成 13/31（41.9%），净差 +22.6 个百分点。

口径限制：只有 2 个完整配对病例；64 条 arm-turn 记录有 21 次失败且均保留在分母；P95 接近 300 秒。不能把它写成已稳定实现 78%→90%，也不应省略小样本和高失败率背景。结构化草稿两臂各 5/7（71.4%），尚不支持 96%。详见 [B1 结果与 Bad Case](B1-SPRINT-002-RESULTS.md)。

### 2. 医学知识检索与循证生成

**状态：`INFRASTRUCTURE_VERIFIED / QUALITY_CLAIM_INSUFFICIENT_EVIDENCE`。** 候选工程表述：

> 基于 Qwen3-Embedding-0.6B 与 FAISS 构建并核验 823,450 个医学知识 chunk 的五源本地索引；固定中英检索 smoke 2/2 返回 3 条证据。GPT-6-Luna 集成运行中，同轮来源 ID 精确匹配 10/20（50%），证据任务同轮引用覆盖 2/4（50%）；当前版本未测医学主张的原文支持率。

PubMed/Wikipedia 是部分快照；慧宜来源是官网公开网页，不是患者 EMR。不要写 79%→92% 支持率或 95% 引用正确率。详见 [B2 证据卡](BULLET2-EVIDENCE.md)。

### 3. 患者记忆与多专家协作

**状态：`ENGINEERING_SIGNAL_OBSERVED / MEMORY_ATTRIBUTION_INSUFFICIENT_EVIDENCE`。** 候选工程表述：

> 在 2 个完整合成纵向病例、22 条配对已披露历史事实中，Integrated 正确引用 16/22（72.7%），Single 为 10/22（45.5%），净差 +27.3 个百分点；AMA trace 记录自动召回 7/8 次完成、记忆提交 9/10 次完成。

此分数只评回答是否正确使用实际披露事实，没有将事实逐条绑定到 AMA 返回的 memory item；复杂病例关键点覆盖率没有评分。不要写成 AMA 跨就诊召回由 72% 提升至 89%，也不要写 +10.5 个百分点。详见 [B3 证据卡](BULLET3-EVIDENCE.md)。

### 4. 医学模型后训练

**状态：`TRAINING_NOT_STARTED_AWAITING_AUTHORIZATION`。** 当前仅有 Q4 GGUF；官方 Transformers checkpoint 约 16.4 GB，当前 Python 缺训练依赖。尚无 Qwen3-8B LoRA、GRPO、冻结医学集或训练前后成绩。不要在简历中写 SFT/RL 提升。详见 [B4 预检卡](BULLET4-PREFLIGHT.md)。

### 5. 私有化推理与云端部署

**状态：`LOCAL_SYNTHETIC_AUTHZ_VERIFIED / CLOUD_DEPLOYMENT_NOT_VERIFIED`。** 候选工程表述：

> 为临床评测 Gateway 实现租户/访问组患者范围和 Session 所有权控制；在 300 例合成患者、600 次本机上下文读取中，150 次授权成功、450 次越范围请求被拒、未授权成功 0 次，loopback 读取 P95 0.99 ms。

该结果不证明云端公网门户、HTTPS、WireGuard、生产 SSO、真实 EMR 权限或并发问诊 P95。详见 [B5 证据卡](BULLET5-EVIDENCE.md)。

## 当前投递判断

这份快照可以作为后续 BOSS 简历项目段落的证据底稿；五条中，B1/B2/B3 的效果提升主张和 B4 后训练均不足以按目标数字投递，B5 只支持本机合成授权结果。不得使用示例中的 78%→90%、79%→92%、72%→89%、62%→71% 或 10.5 个百分点作为已取得成绩。

目前没有操作 BOSS。用户此前要求无需操作 BOSS 界面；简历投递动作保持未执行。
