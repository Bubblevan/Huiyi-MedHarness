#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT}/deployment.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}; copy deployment.example.env and review local paths." >&2
  exit 2
fi

set -a
source "${ENV_FILE}"
set +a

EAGER_ARGS=()
if [[ "${QWEN_VLLM_ENFORCE_EAGER:-0}" == "1" ]]; then
  EAGER_ARGS+=(--enforce-eager)
fi
TEMPLATE_ARGS=()
if [[ "${QWEN_ENABLE_THINKING:-1}" == "0" ]]; then
  TEMPLATE_ARGS+=(--default-chat-template-kwargs '{"enable_thinking":false}')
fi

exec "${QWEN_VLLM_BIN}" serve "${QWEN_MODEL_PATH}" \
  --host 127.0.0.1 \
  --port 8000 \
  --served-model-name "${QWEN_MODEL_ID}" \
  --max-model-len "${QWEN_CONTEXT_WINDOW}" \
  --gpu-memory-utilization "${QWEN_GPU_MEMORY_UTILIZATION}" \
  --dtype bfloat16 \
  --seed 0 \
  --generation-config vllm \
  --enable-auto-tool-choice \
  --tool-call-parser "${QWEN_TOOL_CALL_PARSER:-hermes}" \
  "${TEMPLATE_ARGS[@]}" \
  "${EAGER_ARGS[@]}"
