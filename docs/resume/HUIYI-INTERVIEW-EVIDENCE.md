# Huiyi-MedHarness｜面试证据与口径

## 项目经历可投递结论

可投递的重点仍是临床 Agent 工作流、医学 RAG 与本机边缘 Demo。所有数字均来自合成病例或本机工程验证，不代表临床有效性、公网生产服务或真人医生审核。B3 已完成隔离测量，但没有证明 AMA 回答级收益；协作能力开启臂没有触发专家子运行。因此简历不写 AMA 或多专家协作的独立提升，也不把 B1 组合实验差值归因到这两个组件。

## B1｜统一临床工作流

- **样本：**6 个合成纵向病例、48 组同病例同轮计划任务；前 5 例 40 对完整，第 6 例失败保留于主分母。最终账本 96 条（每臂 48），另有 5 次重试记录，不重复计为计划任务。
- **主结果：**关键任务完成率 Single 26/48（54.17%），Integrated 32/48（66.67%），配对净差 +12.50 个百分点；Integrated 独胜 10、Single 独胜 4、平 34。
- **历史事实：**两臂共同披露的 44 组事实中，正确引用 Single 19/44（43.18%），Integrated 30/44（68.18%），配对净差 +25.00 个百分点；Integrated 独胜 13、Single 独胜 2、平 29。未披露事实不计作遗漏。
- **执行代价：**成功率 47/48（97.92%）对 42/48（87.50%）；端到端 P50 8.92 秒对 20.55 秒，P95 242.38 秒对 300.01 秒。观测 Token 总量分别 1,124,661 与 3,093,652，未换算货币成本。
- **版本：**运行 `20261011104158-f3ea4e2f`，评测源提交 `492595785b61ab795e60588212997a646a805aa2`；冻结 Cohort SHA-256 `7d70893f2ffab9f8711f5ac260a1f70729bef758fb41f7cae50afaa894a6310c`。该运行源提交是后续仓库历史的祖先，不是本次最终提交。
- **限制：**A/B 臂是完整 Harness 组合比较，Integrated 同时开启 AMA、RAG 和协作，故 +25pp 既往事实结果不能归因给 AMA。评分是盲化合成工程评分，不是真人临床审核。医学证据引用有效率为**不可测**：没有可识别的答案证据 ID，且运行未保留检索段落正文；不可写成 0% 或任何提升值。

## B2｜医学 RAG

- **固定样本：**10 个 development 病例各 1 个固定 T07 循证问题，共 10 对、20 次生成；GPT-6-Luna，temperature 0、最多 384 tokens。A 关闭 RAG，B 开启迭代 RAG；两臂均关闭记忆及协作。
- **任务满足率：**Single 1/10（10%），Integrated/RAG 10/10（100%），+90 个百分点；Integrated 独赢 9、Single 独赢 0、平 1。必要信息覆盖分别 2/20 与 20/20。
- **检索与引用：**RAG 臂 9/10 任务至少召回一段；1 个未成功召回的任务仍保留在分母且被评分为完成。29/29 个答案引用 ID 可关联至同轮检索记录。盲评分可见的 28 条医学/工作流主张中，25 条直接支持、3 条部分支持、0 条不支持、0 条矛盾。
- **资源：**索引为五源 `medtext-local-cc7d43568501e6b7`，823,450 chunks，使用 Qwen3-Embedding-0.6B。Single / RAG 的 P50/P95 为 4.90/7.09 秒与 28.00/56.58 秒；观测 Token 总量为 173,074 与 725,846（每题均值 17,307 与 72,585，约 4.19 倍）。Token 不是货币成本。
- **版本：**运行 `resume-b2-20261012053523-609ac99a`，生成源码提交 `8aebe5ed0cc990ee3c191839f1cbb9a514879595`，冻结 Cohort SHA-256 同 B1。早期 6 条错误配置试跑已标为 `invalid-protocol`，保留但不计分。
- **限制：**隔离子 Agent 进行的是盲化模型辅助工程评分，不是临床审核。4 份长回答的评分副本移除了末尾来源列表；主张支持只覆盖副本中可见文本。29/29 只证明引用 ID 可追溯，不证明临床结论正确。10 对开发集结果不外推到 held-out 或临床表现。

## B3｜长期记忆与复杂协作

- **最新隔离运行：**`resume-b3-20261012063421-6e15d54f`，base Git `116059d4a549daedde279e5c87969fe71a749185`，run-source fingerprint `757e723af0128118385b8a84c34eb5d46db3ed590266ea390653e5b8fa697101`，driver SHA `b899d43aa8677356417a13c691a33ed575545a3b785b85b21cbd5d445ee6c988`。Cohort SHA 与 B1/B2 相同。运行 driver 当时未提交，故同时记录 fingerprint 和 driver SHA；结果提交时只更新文档。
- **AMA-only 配对：**3 例合成纵向病例、6 个 T05/T06 配对任务、12 个历史事实机会。RAG 和协作两臂关闭。Single 完成 6/6、AMA-only 完成 5/6（1 次超时保留）；T05 目标事实 ID 命中均为 0/6，成功回答中的精确事实回显均为 0/12。任务打平 6/6，净差 0 pp。只按规范化精确值匹配，不评语义改写。P50/P95 为 5.40/8.57 秒与 14.05/240.00 秒；观测 Token 总量 104,326 与 91,099，不代表货币成本。
- **协作能力开启的配对结果：**6 例复杂 development 病例、14 个冻结关键点；两臂都关闭 AMA/RAG，Integrated 只开启协作能力。Single 完成 3/6、覆盖 8/14（57.1%）；协作能力开启臂完成 1/6、覆盖 3/14（21.4%），配对 Single 独胜 2、Integrated 独胜 0、打平 4。Integrated 有 5 次 240 秒超时。盲化 GPT-6-Luna 评分返回 HTTP 200，但两臂实际协作调用与 child run 均为 **0**。所以 -35.7 pp 是这次能力开关分组的工程结果，**不能归因于已执行的多专家协作**。
- **结果使用规则：**当前不声称 AMA 正确病史引用率提升或多专家协作覆盖率提升。B3 的可核实发现是 AMA-only 的精确回答级收益 0/12，以及协作路由在本轮 0 次触发；B1 中 19/44→30/44 是完整 Harness 差值，仍受 AMA、RAG、协作同时变化的混杂。
- **审计文件：**脱敏逐项结果见 [RESUME-B3-FINAL.json](../eval/RESUME-B3-FINAL.json)；报告见 [RESUME-B3-FINAL.md](../eval/RESUME-B3-FINAL.md)。原始 prompts/answers 留在本机 git-ignored `artifacts/clinical-eval/private/resume-b3-20261012063421-6e15d54f/`。旧冻结运行 `20261011184053-5bce7818` 的机制遥测仍可作为历史补充，但不覆盖这次隔离实验结果。

## B5｜本机边缘 Demo

- **授权 sweep：**300 个合成患者、600 次患者/Encounter 上下文检查；授权读取 150、拒绝 450、越权成功 0；上下文只读 P95 2.59 ms。2 个内存合成账号，无模型生成。
- **Docker HTTPS 边缘链路：**Caddy 静态前端 → edge-auth → 仍绑定 loopback 的 Gateway → DSH → GPT-6-Luna 本地 Codex bridge + 本地 RAG。单次浏览器问诊 HTTP 200、3 条证据、生成结构化草稿；端到端 46.623 秒、SSE 首包 77.8 ms；只标记“需补充问诊”，**未执行临床批准**。
- **边缘 API：**登录 P95 392.02 ms（n=10）；患者上下文读取 P95 10.18 ms（n=10）；并发 10 成功 10/10，并发 20 成功 20/20。另一合成账号访问越权上下文和跨患者会话均返回 404，未触发模型请求；Gateway 不可达时代理返回 502。
- **运行与交付：**两个边缘容器空闲合计约 57.6 MiB；5/5 edge proxy 单测与 23/23 Gateway backend 测试通过。`READY_TO_BUY_VPS` 仅指本地 edge-only 合成演示和配置包达到购机前门槛。
- **没有验证：**公网 DNS/ACME、真实 WireGuard 隧道、VPS 重启/回滚、生产 OIDC/SSO、真实数据库行级权限、真实 EMR、生产临床使用及公网延迟。单次 GPT 请求不是 P95。

## 关键文件

- 简历正文：[HUIYI-BOSS-FINAL.md](HUIYI-BOSS-FINAL.md)
- 机器可读指标映射：[HUIYI-METRICS-MAP.json](HUIYI-METRICS-MAP.json)
- B1 逐任务结果：[BULLET1-EVIDENCE.json](BULLET1-EVIDENCE.json)、[BULLET1-EVIDENCE.md](BULLET1-EVIDENCE.md)
- B2 配对结果：[RESUME-B2-FINAL.json](../eval/RESUME-B2-FINAL.json)、[RESUME-B2-FINAL.md](../eval/RESUME-B2-FINAL.md)
- B3 隔离评测：[RESUME-B3-FINAL.md](../eval/RESUME-B3-FINAL.md)、[RESUME-B3-FINAL.json](../eval/RESUME-B3-FINAL.json)
- B5 部署与本地验收：[deploy/edge-demo/README.md](../../deploy/edge-demo/README.md)、[local-e2e-result-20261012.json](../../artifacts/edge-demo/local-e2e-result-20261012.json)
- B5 截图：[临床草稿](../../artifacts/edge-demo/clinical-workflow-review-20261012.png)、[审阅留痕](../../artifacts/edge-demo/clinical-workflow-audit-20261012.png)
