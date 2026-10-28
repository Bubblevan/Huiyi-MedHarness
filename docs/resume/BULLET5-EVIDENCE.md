# Huiyi 简历 Bullet 5｜本地鉴权与浏览器链路证据

## 已验证

- 本机合成 Gateway 授权 sweep 覆盖 300 个合成患者、600 次患者/Encounter 上下文检查：150 次授权读取、450 次拒绝、**0 次越权成功**；上下文读取 P95 **2.59 ms**，没有发起模型生成。测试使用 2 个内存合成账号，不是生产身份系统。
- 一次真实浏览器 E2E 经认证 Gateway 调用 GPT-6-Luna 和本地 RAG：HTTP 200、DSH run completed、3 条证据、创建结构化复诊草稿并写入 demo review action；单次端到端 **47.677 秒**。`clinicalApprovalPerformed=false`，因此不能称为医生批准。

## 可写简历 Bullet（本机预生产范围）

实现患者级授权 Gateway 与临床工作台浏览器链路；在 300 例合成数据的 600 次上下文访问检查中，授权/拒绝分别为 150/450，越权读取 0 次（只读请求 P95 2.59 ms）；并完成 1 条 GPT-6-Luna、RAG、结构化复诊草稿及审阅留痕的浏览器端到端流程（HTTP 200，47.7 秒）。

## 部署口径

这批证据来自本机合成账户、内存数据及 loopback 服务。没有公网上线、阿里云 HTTPS、WireGuard、生产 OIDC/SSO、真实数据库行级授权、600 并发访问或模型服务 P95 的验证记录；因此不写成“云端生产部署”“600 次越权零风险”或并发 SLA。2.59 ms 仅适用于这次无模型的本地上下文授权读取。

## 证据

- [authz-sweep-20261011-154507.json](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261011-154507.json)
- [browser-e2e-20261011-225644-c5a5caac.json](../../artifacts/clinical-eval/browser-e2e/browser-e2e-20261011-225644-c5a5caac.json)
