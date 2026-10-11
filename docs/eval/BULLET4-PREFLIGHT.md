# B4｜Qwen3-8B 后训练：本机预检与授权状态

## 当前状态

**状态：`TRAINING_NOT_STARTED / AWAITING_WEIGHT_AND_DEPENDENCY_AUTHORIZATION`。** 本机现有模型文件是 Q4_K_M GGUF 推理量化文件，不是 LoRA/QLoRA 所需的 Transformers safetensors checkpoint。当前默认 Python 环境有 PyTorch 与 Transformers，但没有 PEFT、TRL、bitsandbytes、datasets 或 Unsloth。没有下载权重、安装依赖、执行 optimizer step 或生成训练产物。

## 只读预检

- 本机目录 `E:\Health-Copilot-Models\models\qwen3-8b` 有 `Qwen3-8B-Q4_K_M.gguf`，大小约 4.68 GiB；未发现同目录的 `config.json` 或完整 safetensors 权重。
- 官方 `Qwen/Qwen3-8B` 文件页当前显示仓库总量约 **16.4 GB**，包含 5 个 safetensors 权重分片；页面 revision 前缀 `b968826` 与既有模型清单记录一致。
- E 盘当前可用 **158.2 GiB**，足够容纳一份额外的 16.4 GB checkpoint；C 盘可用 11.5 GiB。若获授权，权重、虚拟环境、pip/HF cache 和 adapter 输出都应显式放在 E 盘，避免默认写入 C 盘。
- 当前 GPU 为 RTX 4090 Laptop，16,376 MiB 显存；预检时占用 79 MiB、利用率 0%。这只表示当时空闲，不证明 QLoRA 训练配置一定能稳定放入显存。

## 决策边界

在获得明确授权前，不下载 16.4 GB 权重、不安装训练依赖、不运行 canary。批准后仍先核对依赖安装体积与 E 盘余量，再用合成非医疗数据做小步 QLoRA save/reload smoke；它只能证明训练管线可运行，不能作为医学准确率提升。正式 Bullet 数字仍需要冻结医学训练/验证数据、基座对照和配对评分，不能读取 MedQA TEST。

## 可复核来源

- [官方 Qwen3-8B 文件列表与仓库大小](https://huggingface.co/Qwen/Qwen3-8B/tree/main)
- 本机模型目录：`E:\Health-Copilot-Models\models\qwen3-8b`
- [既有 SFT/LoRA 环境 readiness 记录](../perf/hc-perf-001-sft-readiness.md)
