# H2 Phase D Source-Metadata Audit

As of 2026-10-15. This is a schema and sampled-record audit. It does not assign clinical authority, quality, or applicability.

## Existing prepared metadata

The five-source Qwen manifest records each source's `name`, `revision`, document count, chunk count, and chunk-file path/hash list. The sampled first prepared chunk from each source had these fields:

| Source | Sampled chunk fields | Available provenance observations |
|---|---|---|
| Textbooks | `id`, `title`, `content`, `contents` | No source URI, edition/version, language, publication type, or applicability fields in the sampled prepared row. |
| StatPearls | `id`, `title`, `content`, `contents` | Same sampled field coverage as Textbooks. |
| PubMed | Text fields plus `PMID`, `sourceUri` | Stable PMID and URI are present; the sampled prepared row does not carry publication type, language, version, or applicability. |
| Wikipedia | Text fields plus `wiki_id`, `sourceUri` | Stable wiki ID and URI are present; the sampled prepared row does not carry version, language, or applicability. |
| Huiyi public site | Text fields plus `document_type`, `freshness_class`, `review_status`, `department`, `section_path`, `topic`, source URL and content hashes | The crawl carries useful site-specific fields, but their definitions and provenance must be checked before mapping them to normalized clinical metadata. |

This table describes sampled chunk rows, not full-corpus field coverage. The manifest's current source-level metadata does not record normalized language, publication/version date, or clinical applicability.

## Current Health Engine projection

`CorpusChunkStore` projects a prepared row to `corpus`, `source_document_id`, `chunk_id`, `title`, `content`, and optional `sourceUri`; the other row fields are discarded at load time. `EvidenceHit` currently emits source/corpus, source document/chunk ID, title, snippet, URI, retrieval score and query metadata. Its `sourceType` is hard-coded to `medical_reference` for every source, including the hospital website. That string is not a source-verified publication type or authority grade and must not be interpreted as one.

## Safe Phase D mapping proposal

Extend metadata additively and keep each value tied to a source field or immutable manifest entry:

- `sourceKind`: controlled technical class such as textbook, reference article, PubMed record, encyclopedia page, or hospital webpage.
- `sourceDocumentVersion` / `publicationDate`: populated only from a source-side edition, revision, or publication date; otherwise null.
- `language`: populated from source metadata or a reviewed document-level detector with method/version recorded; otherwise unknown.
- `scope` / `population` / `applicability`: only from explicit source content/metadata and with a supporting span or URI; do not infer it from a title or corpus name.
- `reviewStatus` / `freshnessClass`: retain only for Huiyi pages if the crawl pipeline's definitions and source lineage can be verified; do not generalize those fields to other corpora.
- `authority`: omit unless a source-governed registry and review process defines it. No clinical authority labels are currently supported by this metadata audit.

Keep unknown fields null, preserve the original source identifiers and URLs, and do not merge Encounter/Memory metadata with external evidence. Implement this after the DEV qrels and A–D baseline are frozen so the source metadata change cannot silently alter the current retrieval comparison.

## Evidence-support evaluation still needed

Retrieval qrels measure whether relevant chunks appear in the ranked candidate list. They do not establish that an answer's medical claims are supported. A separate reviewed protocol must distinguish (1) source/citation exists, (2) cited span locates the asserted passage, and (3) the passage supports the claim. Human review remains necessary for claim-support decisions that cannot be checked deterministically. Do not report retrieval Recall/MRR/nDCG as citation validity or clinical correctness.
