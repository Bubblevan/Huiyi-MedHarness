# Huiyi 仓库统一记录（2026-10-28）

唯一活动检出：`D:\MyLab\harness\huiyi\Huiyi-MedHarness`，工作分支 `main`。

## 合并来源

| 来源 | 原状态 | 处理 |
|---|---|---|
| 原主目录 | `aaf15a4`，有早期 F0.1 未提交修改 | 建立私有恢复 ZIP 并逐文件核验；保留最新主线的 README、trace 与测试语义 |
| `Huiyi-MedHarness-run-7ec` | `7ec67f9`，detached，存在本地数据与共享目录链接 | 提交已是最新分支祖先；12 个同名本地文件相同，5 个差异副本另存 |
| `Huiyi-MedHarness-demo-edge-local-001` | `c3050e1`，H2 分支，包含未提交源码/文档及本地资产 | 作为最新实现来源，迁入唯一主目录；保留源码和文档改动 |
| 远程 `origin/main` | fetch 后为 `28ba197` | 已包含在 `c3050e1` 中，无分叉；本地 main 快进，随后正常推送同步 |

原有 Git 历史均保留，并建立 `backup/consolidation-20261028-*` 恢复引用；这些仅是引用，不再创建其他工作树。两个冗余目录与一条失效的嵌套 worktree 登记已清理。没有修改远程旧分支。

## 本地资产与恢复

恢复区：`D:\MyLab\Jianli\artifacts\huiyi-consolidation-20261028`。

- 原主目录非生成文件快照 34 个，ZIP 内容逐文件校验成功。早期未提交的 Qwen 配置、脚本、ADR 和重复 logo 同时保留在 `legacy-main-untracked.private/`；它们属于旧 fixture-only 入口，不覆盖新实现。
- 最新检出迁移 38,502 个文件，保留原有 `.venv`、语料、索引、评测状态及未提交内容。原主目录 `.env`、`.dsh-home` 保留。
- 旧检出 17 个本地文件中，12 个与最新来源相同，5 个不同内容保存在 `run-7ec-conflicts.private/`，没有覆盖最新状态。
- `migration-manifest.private.json` 共 38,519 条来源记录，独立复核 SHA-256 后不匹配数为 0。每条记录指向唯一主目录或差异恢复区。
- 旧检出的环境/语料 Junction 指向最新检出的同一路径，真实内容已迁移；清理时只先解除链接本身。Windows 在 Git 注销后留下的目录，经过精确绝对路径检查后用原生 PowerShell 清理。
- node_modules、构建产物、Python 缓存及 uv 缓存可重建。主目录使用 Corepack 固定 pnpm 11.7.0，从离线缓存按原锁文件安装 451 个包，未下载包，未更新依赖版本。全局 pnpm 8.15.3 与该锁文件不兼容，日常使用应优先遵循 packageManager 固定版本。
- 二进制、私有运行目录等继续保存在本机，使用 `.git/info/exclude` 屏蔽原本未跟踪的生成资产。恢复区包含本地配置，不能发布或作为比赛提交包。

## 验证

| 检查 | 实际结果 |
|---|---|
| 核心 TypeScript 类型检查、bundle build | 通过 |
| 核心 Vitest | 10 个文件，109/109 通过 |
| Gateway Vitest | 7 个文件，55/55 通过 |
| Gateway TypeScript build | 通过 |
| 前端 TypeScript 类型检查 | 通过 |
| 前端 Vitest | 3 个文件，12/12 通过 |
| Production 前端 build + 产物检查 | 通过，6 个构建文件通过文案检查 |
| Edge 前端 build + 产物检查 | 通过，6 个构建文件通过文案检查 |
| Python Health Engine、RAG retrieval/parity 测试 | 94/94 通过 |
| Go edge gateway | `go test ./...` 通过 |

前端原先有 5 个测试仍断言旧英文文案、旧证据标题和已不展示的内部 Encounter ID。本次只调整现有断言，使其检查当前中文提示、业务模型标签、内部 ID 隐藏、证据文本安全展示与错误信息；没有为通过测试回退产品 UI。另规范两份已修改研究文档的换行/尾随空白。

构建仍有约 600 KB chunk 的 Vite 提示，构建本身成功。本次没有启动模型、真实临床服务、临床 live acceptance 或 χ-Bench；不以离线测试替代这些实测结果。

## 后续开发入口

继续在唯一检出的 `main` 工作，沿现有 Huiyi 产品主线增加可复用工作流能力，χ-Bench 只保留薄协议适配。比赛调研见 [研究报告](../research/chi-bench-huiyi-migration-2026-10-28.md)。

远程同步采用非强制推送。验收条件是 `HEAD` 与 `origin/main` 相同、`git rev-list --left-right --count HEAD...origin/main` 为 `0 0`、`git worktree list` 仅一项。
