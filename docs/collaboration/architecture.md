# HC-MA-001 collaboration architecture

```text
                  DSH ROOT AGENT
                       │
               HealthCaseState
          ┌────────────┼────────────┐
          │            │            │
       Memory         RAG      Collaboration
          │            │            │
          └────────────┼────────────┘
                       │
              Collaboration Policy
                       │
             ┌─────────┴─────────┐
           basic               complex
             │                    │
       Single Agent         ctx.subagents
                               │
                    ┌──────────┼──────────┐
                 specialist specialist specialist
                    └──────────┼──────────┘
                            moderator
                               │
                    CollaborationSnapshot
                               │
                        ROOT AGENT CONTINUES
```

There is one Huiyi-owned outer control path. DSH may internally run child Agents through its native subagent service. Huiyi introduces no second custom AgentLoop.

## Ownership

- **DSH** owns Agent and Session lifecycle, AgentLoop, cancellation, provider/model routing, child Agents, tool restriction, structured child output, disposal, lineage, and the traceable child lifecycle.
- **MDAgents** supplies method semantics: adaptive complexity, three processing branches, expert recruitment, specialist discussion, MDT goals/membership, and moderator review. Its runtime implementation is not imported.
- **Huiyi** owns medical case state, complexity semantics, plan normalization, policy budgets, specialist schemas, moderator schema, bounded prompts, degradation behavior, and metadata-only collaboration traces.

`HealthCaseState.patientMemory` reuses the existing `MemorySnapshot`; `externalEvidence` reuses the existing `EvidenceSet`. The fields remain separate and keep their existing producers and lifecycle. Collaboration reads bounded prompt projections and does not call or mutate either subsystem.

## Child execution

`installCollaboration(ctx)` is an explicit composition API. The host must compose DSH's `@deepseek-ai/dsh-subagent` service and `@deepseek-ai/dsh-subagent-spawn-in-process` provider under the provider name `spawn`. Huiyi calls `ctx.subagents.start()` directly; it does not expose a generic model-facing `subagent` tool.

Each one-shot child receives:

- the exact root Agent as parent;
- a fresh DSH `spawn` session with no inherited root transcript;
- a prompt built from the bounded case query, patient-memory snapshot, external-evidence snapshot, assigned role, and task-specific summaries;
- `maxDepth: 1`;
- `toolFilter: { allow: [] }`;
- a role persona and object-rooted `outputSchema`;
- the caller AbortSignal.

The adapter checks the provider, awaits `run.result`, accepts only `stopReason === 'completed'` with present structured output that passes domain validation, and always disposes a published run in `finally`. Non-completed output is metadata-only failure information; partial text is not parsed as a medical finding.

## Profiles and work bounds

The `benchmark` policy records the MDAgents structure: five recruited intermediate specialists, up to five rounds and five turns per round, and three advanced teams with three clinicians each. Its child-run ceiling and concurrency cap are explicit. It is encoded for future parity tests and is not run live in HC-MA-001.

The `product` policy defaults to at most three specialists, two teams, one round, no peer-refinement children, three concurrent child runs, and sixteen total child runs. Product values are intentionally separate from benchmark values and do not claim paper reproduction.

Recruitment output is normalized before execution. Invalid and overlong roles are rejected, duplicate roles within a recruitment response retain only the first valid entry, ids are deterministic, and specialist/team/run counts are capped before children start. Every child start consumes budget first.

## Collaboration and team shape

Intermediate specialists first produce independent findings in bounded parallel execution. Optional peer refinement projects only structured peer summaries into another one-shot child request; the product profile disables refinement by default. Huiyi does not call DSH sibling `sendMessage()` because DSH messaging is limited to adjacent Agents in its continuable-child lifecycle.

Advanced teams are domain topology, not DSH nesting. The root remains parent of every specialist, and the orchestrator groups their findings by `TeamSpec`, invokes bounded team synthesis children, then invokes the moderator. A required team needs at least one completed specialist before synthesis and moderator review can continue.

## Moderator and root ownership

The moderator receives the query, bounded patient-memory and external-evidence projections, specialist/team summaries, and a bounded disagreement projection. It never receives raw hidden reasoning. Its structured decision is decision support for the root Agent. The root DSH AgentLoop still produces the user-facing response. A future benchmark adapter may separately interpret moderator choice as an evaluation answer.

## Failure, cancellation, and trace

Failed specialists degrade the snapshot. Intermediate work can continue with at least one successful specialist. Advanced work requires one successful specialist in every planned active team. No successful specialists means no moderator and no fabricated consensus. A missing or failed moderator leaves specialist/team findings available and `moderator` absent.

Cancellation is passed to every child start. The orchestrator checks cancellation before each start and settles all already-started child calls before returning; the DSH runner disposes every published run. The child-run budget, team caps, round caps, and concurrency cap apply even when recruiter output is adversarial.

Trace records contain a SHA-256 case hash, profile, complexity, task/role labels, opaque run id, start/end times, duration, stop reason, completion state, round, run count, and degradation metadata. They do not contain raw case text, Memory contents, evidence passages, prompts, child outputs, or hidden reasoning.

## Composition fixture

See [`examples/hc-ma-001-collaboration-profile.patch.example.yml`](../../examples/hc-ma-001-collaboration-profile.patch.example.yml) and [`examples/hc-ma-001-collaboration-composition.ts`](../../examples/hc-ma-001-collaboration-composition.ts). The fixture composes the two DSH packages and returns Huiyi's typed capability; normal `apply()` does not invoke it.
