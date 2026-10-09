# HC-MA-002 live validation

## Scope

HC-MA-002 validates the pinned DSH subagent path with the local Qwen3-8B route, integrates the existing AMA Memory and RAG clients through `HealthCaseState`, and runs a fixed four-row MedQA **dev** diagnostic. It does not read TEST labels or change the existing Memory or RAG retrieval implementations.

The diagnostic is a plumbing check, not a benchmark claim. It uses the same frozen question/options-only input for Single and Adaptive. Before each root turn, the harness retrieves one `EvidenceSet` and places the rendered snapshot in that root's scoped system prompt. Adaptive collaboration reuses that same result in the `HealthCaseState` sent to its children. Memory recall remains the existing read-only DSH lifecycle; the synthetic evaluation identity returned no stored patient items.

## DSH integration

`applyWithIdentity()` now mounts the collaboration capability when DSH's native `spawn` service is present. The capability registers its instruction only through each live root Agent's `agent.ctx` during the awaited `agent/created` event. DSH's `agents.roots()` check prevents the root policy from appearing in children. Children are fresh `spawn` Agents with `maxDepth: 1` and `toolFilter: { allow: [] }`; their only model-facing tool during structured execution is DSH's `structured_output` transport.

The CPU composition fixture creates actual pinned DSH root and child Agents. It checks that the root sees the Huiyi collaboration instruction and tool, while a restricted child sees neither. The standard collaboration runner continues to require a completed DSH child result with schema-valid structured output and disposes every published run.

## Historical parser and runtime review

The historical `f0.1-local-qwen-initial-diagnostic` metadata records a DSH turn that ended with `error` before inference because the local vLLM endpoint did not accept `tool_choice=auto` without `--enable-auto-tool-choice` and a tool parser. The later `f0.1-local-qwen-live-20261007` diagnostic passed its tool-required, no-tool, and empty-hit turns after that server configuration was applied. The HC-MA-002 Qwen server used the same required tool-call support with the pinned DSH Pi-AI adapter; all eight root turns in the final diagnostic completed, structured tool results had no errors, and no child attempted `consult_clinical_team`.

The historical RAG parity parser in `eval/rag-parity/answer_parser.py` is stricter and handles known Qwen wrappers (`<think>` blocks, fenced JSON, `answer_choice`, and an option letter followed by option text). The HC-MA-002 runner currently uses a smaller parser for an `answer` JSON field and common `answer:` / `choice:` text. One earlier precheck completed at the DSH level but produced an unparsed choice; its raw response was deliberately discarded, so its exact format cannot be diagnosed or repaired after the fact. All eight rows in the final shared-context run parsed successfully. Keep that parser distinction visible in future output reviews; do not infer that a completed DSH turn necessarily yielded a parseable benchmark answer.

## Final fixed dev diagnostic

The final run used the four frozen rows recorded in `artifacts/hc-ma-002/diagnostic-selection.json`, with one question/options-only projection and the same RAG snapshot per case in both arms. The separate dev answer key was opened only after the prediction file was closed.

| Arm | Correct | Parsed | Root turns | Collaboration |
|---|---:|---:|---:|---|
| Single | 4/4 | 4/4 | 4/4 completed | 0 specialist children |
| Adaptive | 4/4 | 4/4 | 4/4 completed | two basic cases; two intermediate cases with 3/3 specialists and a moderator each |

One basic case had a failed classifier child and returned a degraded collaboration result; the root still completed its Single Agent answer. The other basic classification completed. There were 14 structured child calls across Adaptive cases, zero child collaboration-tool calls, and zero failed DSH tool results. These eight predictions are a four-question smoke diagnostic; the equal scores do not establish an accuracy effect or paper parity.

The Memory service completed eight read-only recalls, each with zero stored items for the synthetic user, and skipped all eight turn commits under the evaluation read-only policy. Each case/arm used one non-degraded RAG retrieval with three hits. Query text, evidence passages, prompts, specialist findings, and raw model responses are not stored in the committed artifacts; the sample collaboration trace contains lifecycle metadata only.

## Protected data boundary

- Source split: MedQA dev only; no TEST labels read.
- Inference projection: `id`, `question`, and `options`; answer keys remain outside this repository.
- Memory: read-only; no evaluation turn writes.
- Git artifacts: hashes, choices, correctness counts, DSH lifecycle metadata, and run configuration only.
- Existing `artifacts/hc-rag-*`, `eval/rag-parity/*`, and `eval/memory/locomo/*` results were not modified.
