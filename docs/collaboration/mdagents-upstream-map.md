# MDAgents upstream semantic map

## Pins and inspection scope

- MDAgents: `mitmedialab/MDAgents` at `3adbd760ca809b4e7b0c1085d68314b6e7d91e1b`.
- DeepSeek Harness: `deepseek-ai/deepseek-harness` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, package/runtime `0.2.1-alpha.1`.
- Inspected MDAgents files: [`main.py`](https://github.com/mitmedialab/MDAgents/blob/3adbd760ca809b4e7b0c1085d68314b6e7d91e1b/main.py) and [`utils.py`](https://github.com/mitmedialab/MDAgents/blob/3adbd760ca809b4e7b0c1085d68314b6e7d91e1b/utils.py).
- Inspected DSH files: [`subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/subagent/subagent/src/index.ts), [`subagent/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/subagent/subagent/src/types.ts), [`subagent-spawn-in-process/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/subagent/subagent-spawn-in-process/src/index.ts), and [`core/tools/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/tools/src/index.ts).

## Method mapping

| Upstream function or symbol | Semantic responsibility | Pinned implementation | Huiyi decision and target | Why |
|---|---|---|---|---|
| `main.py` adaptive routing flow | Select basic, intermediate, or advanced processing for each query | Calls `determine_difficulty(question, args.difficulty)` and dispatches to the matching `process_*_query` function. `adaptive` is the default CLI difficulty. | **Adapt** to `classifyComplexity` plus a typed `CollaborationPlan` in `src/collaboration/planner.ts` and `orchestrator.ts`. | Keep the routing method while replacing CLI branching and string decisions with typed contracts. |
| `utils.py: Agent` | Give a medical role a model-backed chat history and prompt interface | The mutable `Agent` owns `instruction`, `role`, `model_info`, provider clients, and a mutable `messages` array; it selects OpenAI or Gemini clients and exposes chat / temperature response helpers. | **Drop implementation; preserve role semantics** in `SpecialistSpec`, prompt builders, and one-shot DSH child requests. | DSH owns Agent lifecycle, provider routing, Session, and model calls. |
| `utils.py: Group` | Represent an MDT goal, members, and internal collaboration | Creates member `Agent`s; selects a lead; asks the lead to assign investigations to assistant clinicians; gathers their responses; asks the lead to synthesize a final group answer. Its `external` interaction branch is a stub. | **Adapt** to `TeamSpec`, parallel specialist findings, and a bounded team synthesis child in the collaboration orchestrator. | Preserve goals, membership, lead, investigation, and synthesis as domain data and bounded calls. Drop the Python runtime and unused external branch. |
| `utils.py: determine_difficulty` | Map adaptive cases to basic / intermediate / advanced | Non-adaptive values pass through. Adaptive mode asks a medical Agent and searches returned text for `basic`, `intermediate`, `advanced`, or numbered labels. | **Adapt** to `ComplexityDecision` and a DSH `outputSchema` in `schemas.ts`. | Keep the three-level decision; avoid substring parsing as the product contract. |
| `utils.py: process_basic_query` | Answer a basic case with one medical agent | Builds one medical Agent, adds a small MedQA example set when configured, and asks it for the answer. | **Preserve semantics** as the root's ordinary Single Agent path; the collaboration plan has no specialists, teams, or moderator. | Basic routing must not create a redundant child team. The root DSH AgentLoop remains responsible for the answer. |
| `utils.py: process_intermediate_query` | Recruit experts, model hierarchy/independence, collect independent opinions, support peer discussion, collect final answers, and ask a moderator for a majority decision | Recruiter requests five experts and explicit hierarchy or independent relations. Text is parsed by delimiters. The benchmark code sets `num_agents = 5`, `num_rounds = 5`, and `num_turns = 5`; experts choose peers during rounds and submit final answers; a moderator produces the majority decision. | **Adapt** to typed recruitment, independent structured findings, bounded optional refinement rounds, and moderator review. Benchmark values remain in `policy.ts`; product values are separately capped. | Keep the research method shape while bounding product work and using typed DSH children. Peer exchange is mediated by Huiyi because DSH does not authorize arbitrary sibling messaging. |
| `utils.py: process_advanced_query` | Recruit MDT teams, run team investigation/synthesis, and make a final decision | The prompt sets `num_teams = 3` and `num_agents = 3`, requests goals and members, and asks for Initial Assessment and Final Review/Decision teams. `Group.interact('internal')` performs lead/assistant work; the code separately builds initial, other-team, and final-review reports. Its final-decision prompt currently supplies the initial-assessment report. | **Adapt** to typed `TeamSpec[]`, orchestrator-owned specialist children, `TeamFinding[]`, and moderator input that includes bounded findings from all teams. | Preserve team goals, membership, intra-team findings, and cross-team synthesis. Correctly include collected summaries in Huiyi's moderator input; do not reproduce incidental report wiring. The benchmark profile records the stated three-by-three defaults without launching them. |
| `utils.py: parse_hierarchy` | Render the recruited intermediate expert relations | Uses delimiter-based role parsing and `pptree.Node` objects; missing relation text defaults to `Independent`; relation strings are split on `>`. | **Drop parser and tree rendering; adapt relation semantics** into typed specialist metadata and orchestrator peer-summary projections. | Product contracts should not depend on free-form format and terminal rendering. |
| `utils.py: parse_group_info` | Extract an MDT goal and member role/expertise | Splits raw lines and delimiters (`-`, `:`) into `group_goal` and member dictionaries. | **Drop parser; adapt** to `RecruitmentPlan` / `MdtPlanning` schemas and `TeamSpec`. | DSH structured outputs provide validated objects without recreating fragile text parsing. |

## Upstream branch semantics

### Basic

`basic` means one medical agent produces the answer. Huiyi represents this as an empty collaboration plan; the root remains responsible for its normal answer.

### Intermediate

The pinned benchmark flow is recruiter → five medical experts → hierarchy or independent relations → independent opinions → up to five rounds with up to five discussion turns per round → specialist final answers → moderator majority decision. These counts and the peer-interaction method are benchmark semantics, not product defaults. Huiyi's product profile is deliberately smaller and may use a single bounded refinement projection.

### Advanced

The pinned implementation requests three MDTs with three clinicians each, gives teams distinct goals, and models team lead/assistant investigation followed by a final decision-maker. The prompt also asks for Initial Assessment and Final Review/Decision teams; this sits awkwardly beside the three-team count and should be recorded as an upstream prompt inconsistency. Huiyi retains the typed team topology but caps it separately by profile. It does not create nested DSH children for team members.

## DSH facts used by the adaptation

- `ctx.subagents.start(name, request)` is the one-shot service seam. Its request carries `parent`, `prompt`, and `signal`; optional capabilities include `outputSchema`, `maxDepth`, `toolFilter`, and `persona`.
- The `spawn` provider advertises structured output, depth limit, tool filtering, and persona support. It creates a fresh child with no parent conversation seed (`inheritsParentContext = false`).
- `outputSchema` must be an object-rooted DSH-compatible JSON schema. A schema request does not guarantee success: the consumer must check `stopReason === 'completed'`, `structured` presence, and Huiyi domain validation.
- `toolFilter` is a `ToolRestriction` with `allow` and `deny` names. An empty `allow` list removes inherited global tools, including model-visible RAG, Memory, filesystem, network, shell, and subagent tools.
- `SubagentRun.result` resolves to a `SubagentResult`; non-completed stop reasons include `aborted`, `error`, `max-tokens`, and `refusal`. The holder must call `dispose()` to cancel remaining work and reach quiescence.
- `sendMessage` is an adjacent-Agent operation for continuable children. It is not a sibling broadcast API. Huiyi sends bounded peer-summary projections as explicit inputs to later child runs instead.

No MDAgents Agent runtime or provider client is imported into Huiyi. HC-MA-001 is a product adaptation, not an exact reproduction.
