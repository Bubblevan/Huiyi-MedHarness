# Evidence citation ID resolution

The RAG service assigns every retrieved chunk an opaque `MED-<16 hex>` identifier derived from the corpus name, source-document ID, chunk ID, and exact chunk content. Repeated retrievals of the same chunk produce the same ID; a changed source chunk produces a different ID. The source identifiers and passage text remain in the RAG response, while the evaluation run record keeps only evidence IDs and bounded source metadata.

When RAG is enabled, DSH is instructed to cite a retrieved source with `[evidence:<ID>]`, using an ID returned during that task. After a successful search it must include a short source line listing every returned ID, including hits it judges irrelevant; those must be labelled as retrieved but not used as support. It must not invent an identifier, and it must say when retrieval returned no source.

The engineering scorer measures two separate things:

- **Same-task citation ID resolution:** emitted `[evidence:<ID>]` tokens that exactly match an ID returned by RAG in that task, divided by all emitted citation tokens.
- **Citation coverage:** evidence-required tasks that completed and emitted at least one valid citation in that task, divided by the evidence-required tasks represented in the run. A citation appearing in a later turn does not satisfy the earlier task's coverage. Failed runs and missing citations remain in the denominator.

For longitudinal conversations, the run report may also show **same-patient, same-arm session ID resolution**: a token resolves when its exact ID was returned by RAG in the current task or an earlier turn of that same patient execution. It never uses a future retrieval, a different patient, or the other experiment arm. This explains whether a late citation refers to a source already retrieved in the conversation; it does not change the stricter task-level coverage result.

These are source-linkage measures. They do not determine whether a cited passage supports the adjacent claim. That semantic evidence-support rate remains unmeasured without an independent claim-to-passage judgment. If no recognized citation token is emitted, ID resolution is reported as not measurable and coverage reports the missing-citation rate rather than assigning a fabricated validity rate.
