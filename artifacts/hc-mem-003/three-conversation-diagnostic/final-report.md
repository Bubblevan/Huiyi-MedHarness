# HC-MEM-003：完整对话边界诊断

> 范围：诊断性三臂 QA，不是全量 LoCoMo 结果。只构建并评测了完整的 conv-26、conv-30、conv-41。

## 范围与冻结状态

- 数据集 SHA-256：`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。
- 构建到下一个完整 conversation boundary：70/272 个 session，1,451 个 dialogue item；最后完整对话为 `conv-41`（32/32 sessions）。
- 只选上述三段完整对话：385 个非 category-5 问题；本 cohort 排除 category 5 共 112 题，四类计数为 74/90/21/200。
- A/B/C 的冻结存储副本逐字节一致：`True`；tree SHA-256：`c00f7fc17d3fce48ecc0049c8434ff6d5d686ea50717fec5a3593901e25ad010`。冻结 store 的 `partial=true` 是相对全量数据集而言，三段所选 conversation 本身均完整。
- QA：Qwen3-8B revision `b968826d9c46dd6066d109eabc6255188de91218`，temperature 0，禁用 thinking，统一 max_tokens=256；AMA strongRetrieve=true、turnRetrieve=3、topK=10。评测只读。

## 三臂结果

| Arm | Token-F1 | BLEU-1 | Parse errors | QA prompt tokens | QA completion tokens | E2E P50 / P95 (ms) |
|---|---:|---:|---:|---:|---:|---:|
| A upstream | 0.4429 | 0.3931 | 2 | 1,719,539 | 19,964 | 6239 / 12163 |
| B sidecar | 0.4387 | 0.3818 | 2 | 1,351,946 | 19,797 | 5974 / 11614 |
| C real DSH | 0.4408 | 0.3860 | 0 | 1,365,068 | 19,647 | 5994 / 11676 |

## 分类结果

| 类别 | N | A F1 / BLEU | B F1 / BLEU | C F1 / BLEU |
|---|---:|---:|---:|---:|
| single-hop | 74 | 0.3962 / 0.3430 | 0.4190 / 0.3655 | 0.3943 / 0.3374 |
| multi-hop | 21 | 0.1309 / 0.1148 | 0.1711 / 0.1507 | 0.1531 / 0.1337 |
| temporal | 90 | 0.2904 / 0.2511 | 0.2788 / 0.2297 | 0.3119 / 0.2604 |
| open-domain | 200 | 0.5615 / 0.5047 | 0.5460 / 0.4805 | 0.5463 / 0.4869 |

## Parity 诊断

- A→B：F1 `-0.0042`，BLEU-1 `-0.0113`。385/385 retrieval hash 一致。F1 在 0.01 容差内；BLEU 绝对差 0.01128，较 0.01 阈值多 0.00128。精确回答仅 251/385 相同，因此不能仅凭 retrieval hash 宣称 QA 输出等价。
- B→C：F1 `+0.0022`，BLEU-1 `+0.0042`，整体均在 ±0.01 内；类别退化均未超过 0.05。385/385 MemorySnapshot 与 source refs 一致。
- C 臂每题恰好一次 automatic recall、一个 DSH model step；0 tool calls、0 memory writes。C 真实经过 DSH Session、Agent、AgentLoop 和 Huiyi memory lifecycle。
- A→C：F1 `-0.0020`，BLEU-1 `-0.0071`。

## 解释与停止点

**对这次要验证的集成问题，结果是好的：DSH 相对 sidecar 没有观察到有意义的质量回退，且快照和来源引用完全一致。** A→B BLEU 有一个很小的容差超限；它发生在检索等价的情况下，应该作为小 cohort QA 变动记录，而不是据此归因于数据适配或扩大结论。

这次不是全量 LoCoMo，也不用于判断论文目标：未评测其余 7 个 conversation，没有恢复旧的 full local reference，也没有跑 GPT-4o-mini judge。不要把本诊断 cohort 的结果和论文全量 0.510 Token-F1 / 0.432 BLEU 作数值等价比较。

按要求在完整 conversation boundary 后完成 A/B/C 小规模 QA、核验 snapshot parity 与 integration delta，并在此停止；没有继续构建剩余 conversation。

最终诊断状态：`PASS_DSH_PARITY_DIAGNOSTIC_WITH_A_B_BLEU_NEAR_MISS`。
