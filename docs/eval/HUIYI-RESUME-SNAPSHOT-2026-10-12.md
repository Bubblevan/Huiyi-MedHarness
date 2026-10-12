# Huiyi-MedHarness｜简历项目经历快照（2026-10-12）

**定位草稿：** 医疗 Agent 工作流与本机工程验证。职务“系统开发负责人”和开发时间“2026.07–2026.10”来自用户提供的简历目标；具体个人职责仍需本人确认。

**项目介绍草稿：** 面向互联网医院复诊场景，构建基于 DeepSeek Harness 的临床 Agent 工作台原型，整合合成患者/Encounter 上下文、AMA 纵向记忆、本地医学 RAG、多专家协作及结构化复诊草稿流程；所有当前量化结果均来自合成数据或本机工程评测，不代表临床验证或生产服务质量。

## 当前可核实的技术栈

TypeScript、Python、DeepSeek Harness、GPT-6-Luna（Codex app-server）、Qwen3-Embedding-0.6B、FAISS、AMA、MDAgents-derived 协作。Qwen3-8B 当前 E 盘副本是 Q4 GGUF 推理权重；LoRA/GRPO 尚未训练。没有证据支持将阿里云、WireGuard 或生产 SSO 写作已完成部署。

## 五条 Bullet 的当前候选与状态

### 1. 临床 Agent 全链路

**状态：`RESUME_READY`（仅限 5 例合成工程试跑的窄口径）。** 候选工程表述：

> 基于 DeepSeek Harness 打通合成患者/Encounter 上下文、医学工具调用、复杂病例协作、草稿生成与会话级状态管理；GPT-6-Luna 固定 Cohort 的 5 例合成工程试跑中，Integrated 关键任务完成 39/40（97.5%），Single 完成 23/40（57.5%），配对净差 +40.0 个百分点；已披露历史事实正确引用率为 36/40（90.0%）。

口径限制：只有 5 个合成病例、40 个配对任务；全部预定任务均保留在分母。最终 80 条 arm 记录完成；另有 21 次旧失败尝试保留在 attempt history。延迟 P95 为 Single 14.52 秒、Integrated 116.13 秒；有效结构化草稿两臂均为 10/10。未经临床审核，不能外推至 300 例或真实患者。详见 [B1 结果与 Bad Case](B1-SPRINT-002-RESULTS.md)。

### 2. 医学知识检索与循证生成

**状态：`INFRASTRUCTURE_VERIFIED / QUALITY_CLAIM_INSUFFICIENT_EVIDENCE`。** 候选工程表述：

> 基于 Qwen3-Embedding-0.6B 与 FAISS 构建并核验 823,450 个医学知识 chunk 的五源本地索引；固定中英检索 smoke 2/2 返回 3 条证据。GPT-6-Luna 集成运行中，引用 ID 有 47/48（97.9%）可在同患者同会话内追溯；5 个循证回答的片段级直接支持为 8/13（61.5%），属于非独立小样本工程复核，无 RAG 对照或临床审核，不能声称效果提升。

PubMed/Wikipedia 是部分快照；慧宜来源是官网公开网页，不是患者 EMR。不要写 79%→92% 支持率或 95% 引用正确率。详见 [B2 证据卡](BULLET2-EVIDENCE.md)。

### 3. 患者记忆与多专家协作

**状态：`ENGINEERING_SIGNAL_OBSERVED / MEMORY_ATTRIBUTION_INSUFFICIENT_EVIDENCE`。** 候选工程表述：

> 在 5 个合成纵向病例、40 条配对已披露历史事实中，Integrated 正确引用 36/40（90.0%），Single 为 21/40（52.5%），净差 +37.5 个百分点；AMA trace 记录自动召回 13/14 次完成、记忆提交 19/22 次完成。

此分数只评回答是否正确使用实际披露事实，没有将事实逐条绑定到 AMA 返回的 memory item；复杂病例关键点覆盖率没有评分。不能把事实正确引用归因于 AMA 跨就诊召回效果。详见 [B3 证据卡](BULLET3-EVIDENCE.md)。

### 4. 医学模型后训练

**状态：`TRAINING_NOT_STARTED_AWAITING_AUTHORIZATION`。** 当前仅有 Q4 GGUF；官方 Transformers checkpoint 约 16.4 GB，当前 Python 缺训练依赖。尚无 Qwen3-8B LoRA、GRPO、冻结医学集或训练前后成绩。不要在简历中写 SFT/RL 提升。详见 [B4 预检卡](BULLET4-PREFLIGHT.md)。

### 5. 私有化推理与云端部署

**状态：`LOCAL_SYNTHETIC_AUTHZ_VERIFIED / CLOUD_DEPLOYMENT_NOT_VERIFIED`。** 候选工程表述：

> 为临床评测 Gateway 实现租户/访问组患者范围和 Session 所有权控制；在 300 例合成患者、600 次本机上下文读取中，150 次授权成功、450 次越范围请求被拒、未授权成功 0 次，loopback 读取 P95 0.99 ms。

该结果不证明云端公网门户、HTTPS、WireGuard、生产 SSO、真实 EMR 权限或并发问诊 P95。详见 [B5 证据卡](BULLET5-EVIDENCE.md)。

## 当前投递判断

截至本次快照，B1 有可核实的窄口径合成工程 A/B 数字（5 例、40 对：97.5% 对 57.5%，+40.0 pp），不代表临床效果。B2 已测索引规模、引用可追溯和首批片段支持性；由于无干净 RAG 对照，医学答案质量提升仍证据不足。B3 已有历史事实引用配对分数，但 AMA 来源归因和复杂病例覆盖尚未测量。B4 后训练未开始；B5 只支持本机合成授权结果，云端部署未验证。目标中的 300 例/2,400 轮、临床人工审核、医学答案准确率对照、AMA 来源级召回和生产部署等指标尚未全部产出。不得将示例中的预设提升数字当作已取得成绩。

目前没有操作 BOSS。用户此前要求无需操作 BOSS 界面；简历投递动作保持未执行。
