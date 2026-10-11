# Evidence citation ID resolution

The RAG service assigns every retrieved chunk an opaque `MED-<16 hex>` identifier derived from the corpus name, source-document ID, chunk ID, and exact chunk content. Repeated retrievals of the same chunk produce the same ID; a changed source chunk produces a different ID. The source identifiers and passage text remain in the RAG response, while the evaluation run record keeps only evidence IDs and bounded source metadata.

When RAG is enabled, DSH is instructed to cite a retrieved source with `[evidence:<ID>]`, using an ID returned during that task. After a successful search it must include a short source line listing every returned ID, including hits it judges irrelevant; those must be labelled as retrieved but not used as support. It must not invent an identifier, and it must say when retrieval returned no source.

The engineering scorer measures two separate things:

- **Citation ID resolution:** emitted `[evidence:<ID>]` tokens that exactly match an ID returned by same-task RAG, divided by all emitted citation tokens.
- **Citation coverage:** evidence-required tasks that completed and emitted at least one valid citation, divided by all planned evidence-required tasks. Failed runs and missing citations remain in the denominator.

These are source-linkage measures. They do not determine whether a cited passage supports the adjacent claim. That semantic evidence-support rate remains unmeasured without an independently reviewed claim-to-passage judgment. If no recognized citation token is emitted, ID resolution is reported as not measurable and coverage reports the missing-citation rate rather than assigning a fabricated 0/100 validity result.
