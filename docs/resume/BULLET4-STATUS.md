# Huiyi 简历 Bullet 4｜后训练证据状态

## 当前结论：没有可写的模型提升数字

本机 `E:\Health-Copilot-Models\models\qwen3-8b` 目前只找到 `Qwen3-8B-Q4_K_M.gguf`（5,027,783,488 bytes）。该目录不是 Hugging Face 可训练 checkpoint，没有 `config.json` 或完整 safetensors 权重；两个已检查的标准 Hugging Face cache 位置也没有 Qwen3-8B safetensors 快照。

本机 Python 3.12.4 可导入 `torch`、`transformers`、`safetensors`，但当前环境没有 `trl`、`peft`、`accelerate`、`bitsandbytes` 或 `datasets`。GPU 只读检查显示 RTX 4090 Laptop 有 15,841 MiB 可用显存、系统有 41.1 GiB 可用内存；因此本轮没有启动训练或加载模型。缺少可训练权重与适配训练环境，且用户此前要求谨慎控制下载，故没有安装依赖、下载权重或将 GGUF 当作训练 checkpoint。

仓库现有 HC-PERF-001 readiness 记录也明确：没有 optimizer step、LoRA adapter、checkpoint save/reload 或 GRPO rollout。其他目录中的 MediX-R1 训练代码/产物属于另一项目，未混作 Huiyi 的后训练成绩；可见旧评测文件对应 `medix-r1_2b_dapo` 的 RadVQA 49.45%，不是 Qwen3-8B SFT/GRPO 结果。旧项目说明中的 Qwen3.5-9B/GSPO 数字没有在当前可见的训练权重或完整运行记录中复核，暂不沿用。

## 简历处理

**Bullet 4 暂无可发布的训练成果数字，不能写“LoRA/GRPO 提升准确率”。** 目前只能写已规划的训练方案，不能放进有量化结果的项目 Bullet。要产出可核实增益，至少需要可训练的 Qwen3-8B HF/BF16 或明确支持训练的基座权重、受控的医学 SFT/RL 数据及训练环境，然后执行冻结验证集上的基座/候选配对评分。任何新增权重或大依赖下载前需先确认具体体积和目标盘空间。

## 机器可读环境记录

[HC-PERF-001 readiness artifacts](../../artifacts/hc-perf-001/final-report.md) 保存了先前训练环境检查；本报告补充本机模型目录、Python 包和当前 GPU 空闲状态。尚无 Huiyi SFT/GRPO 训练结果 artifact。
