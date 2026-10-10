# 临床工作台生产配置边界

前端按 Vite 环境构建。默认 `vite dev` 是本地开发/演示；默认 `vite build` 是生产。可用 `VITE_APP_ENV=demo` 构建独立演示版本。生产环境名可由 `VITE_APP_ENV_LABEL` 或页面启动前注入的 `window.HuiyiRuntimeConfig.environmentName` 提供。

运行时配置结构：

```ts
window.HuiyiRuntimeConfig = {
  environmentName: "生产环境",
  providerName: "机构配置的 provider",
  modelName: "机构配置的 model",
  version: "部署版本号",
  auditUrl: "/audit",
  patientContextUrl: "/api/patient-context/current",
};
```

Gateway 的 `/api/health` 可提供已配置的 provider/model 名称。不要在静态前端写入模型 API Key。患者上下文地址必须由经过认证、授权和审计的后端实现；当前 Demo Gateway 只有 `/api/demo/patients/:id` fixture 路由，生产构建会拒绝使用该演示路由并保持无患者空状态。生产患者/Encounter 接口尚未在本仓库实现，配置 URL 本身不代表已具备 EMR 集成或权限控制。

组织页脚显示单位官网、通信地址和办公电话；部署版本、环境名和可选审计链接从 runtime config 或构建环境读取。生产 build 会扫描产物，阻止演示提示和合成患者种子标识进入前端资源。
