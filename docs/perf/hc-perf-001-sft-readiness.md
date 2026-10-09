# HC-PERF-001 SFT environment readiness

## Environment inventory

The serving venv uses Python 3.11.17, PyTorch 2.13.0+cu130, Transformers 5.17.0, TRL 1.13.0, PEFT 0.21.2, Unsloth 2026.9.14, Accelerate 1.15.0, bitsandbytes 0.50.2, datasets 4.8.5 and safetensors 0.8.0. Package import and trainer-signature checks passed. The exact local Qwen3-8B BF16 checkpoint is available at revision `b968826d9c46dd6066d109eabc6255188de91218`.

`ray`, `tensordict`, `omegaconf` and `verl` are absent from the inspected environment. The health-engine uses a separate Python 3.12.3 environment. No environment upgrades or package installs were made for this audit.

## Canary outcome

BF16 LoRA and 4-bit QLoRA training canaries were not run. After the task-owned vLLM process stopped, the visible GPU memory remained at 36,895 MiB with zero utilization and no process attribution; subsequent `nvidia-smi` driver queries intermittently failed. Starting an optimizer step in that state would violate the shared-GPU boundary. No optimizer, training step, adapter, checkpoint, or reload test was created.

Therefore the audit confirms package availability and imports only. It does **not** establish that model loading, LoRA target modules, backward pass, optimizer state, checkpoint save/restore, or inference reload fit and work together on this L40.

## Deferred canary plan

Once the GPU is confirmed free and attributable, run a short synthetic-data-only check with 32 non-sensitive arithmetic instruction/response examples. Keep it outside the Dev/TEST evaluation boundary. For BF16 LoRA, load the local base, attach rank-8 LoRA to Q/K/V/O and gate/up/down projections, perform at most three optimizer steps, save the adapter outside Git, reload it, and run one fixed synthetic prompt. Run the 4-bit NF4 QLoRA variant only if the same device has sufficient verified headroom. Record finite loss, step time, peak VRAM, and save/reload status; stop on OOM or non-finite values.

This is a deferred environment preflight, not formal SFT, dataset training, model-quality evaluation, or evidence of capability improvement. Never share the device with a live vLLM evaluation.

## RL readiness

Future veRL/GRPO remains blocked. The inspected environment lacks the pinned veRL, Ray, tensordict and OmegaConf stack, and no single compatible training environment was demonstrated. No RL runtime, rollout, optimizer, or training work was started in HC-PERF-001.
