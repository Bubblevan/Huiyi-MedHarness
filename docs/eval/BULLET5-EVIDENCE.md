# B5｜患者访问控制与推理部署：本机证据冻结

## 决定

**状态：`LOCAL_SYNTHETIC_AUTHZ_VERIFIED / CLOUD_DEPLOYMENT_NOT_VERIFIED`。** 当前源码通过本机合成 Gateway 的 600 次患者上下文授权 sweep；该结果不证明阿里云入口、HTTPS 生产配置、WireGuard 隧道、生产 SSO、真实 EMR 隔离或持续并发性能。

## 本机授权结果

- **源码：** `4b488be988371795cb0a4d775dee0a8b34e3e797`；授权相关源文件未修改，fingerprint `6d8f412573067d680a624629dd25d4ba5f4b364c07b05e507c30bdcc4f8e2c66`。
- **场景：** GPT-6-Luna 路由 attestation 下的 loopback 临床评测 Gateway，300 例合成患者、每例 3 个 Encounter、2 个临时 clinician 账号；无模型生成请求。
- **600 次上下文读取：** 150 次授权成功、450 次越范围拒绝、0 次未授权成功、0 个意外状态。跨账号删除他人 Session 返回 404；所有者删除返回 204；两个账号登出后，受保护患者列表均返回 401。
- **延迟：** 患者上下文读取 P95 为 **0.99 ms**。这是内存合成 Gateway 的单次本机读请求延迟，不是完整问诊延迟或公网 SLA。
- **资源：** 运行前后 RAM 可用 44.0→43.9 GiB；C/D/E 可用空间保持 11.5/179.7/158.2 GiB；生成模型请求为 0。

## 可写与不可写

**简历候选（仅本机合成授权口径）：**

> 为临床评测 Gateway 实现租户/访问组患者范围和 Session 所有权控制；在当前源码的 300 例合成患者、600 次上下文读取中，150 次授权成功、450 次越范围请求被拒，未授权成功 0 次，loopback 读取 P95 0.99 ms，并验证跨账号删会话和登出后访问拦截。

**不能据此写**“阿里云生产已部署”“WireGuard 已打通”“生产患者零越权”或“端到端问诊 P95 0.99 ms”。云端门户、HTTPS 入口、WireGuard 本地回连、生产身份提供方、持久化患者级授权和公网故障压测均未由这次测试覆盖。

## 可复核来源

- [当前源码授权 sweep 原始结果](../../artifacts/clinical-eval/authz-sweeps/authz-sweep-20261012-041505.json)
- [授权 sweep 执行脚本](../../scripts/eval/authz-sweep.ps1)
- [项目证据边界与部署现状](../product/evidence-backed-project-profile.md)
