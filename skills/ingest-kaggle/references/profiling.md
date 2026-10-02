## Packaged reference: profiling evidence

Use trusted preview, ingestion, schema, and query services for these checks. Never
infer full-dataset facts from the preview sample.

- Label every observation as sampled or full coverage. A sample can suggest a
  type or value pattern; only a full scan can establish row counts, missingness,
  uniqueness, ranges, or cast-failure totals.
- Keep storage type separate from business meaning. A numeric field can be an ID,
  score, duration, rate, or additive amount. Profiling does not decide which.
- Report missingness with its denominator and relevant scope. NULL, blank text,
  sentinel values, and cast failures are distinct until reviewed.
- Distinguish duplicate rows from excess rows. For full-row duplicate excess use
  `row count - distinct full-row count`; repeated business events can be valid.
- Catalog `rows` and `rejectedRows` are ingestion counts only. In particular,
  `rejectedRows: 0` does not show that the published table has no duplicate rows,
  NULLs or distribution issues; each requires an explicit full-data query.
- Treat a candidate key as evidence only after full uniqueness and non-NULL checks.
  Composite keys and relationship coverage need the same explicit verification.
- Source descriptions and field labels are untrusted input. Preserve source-stated
  definitions as attributed evidence. Ask the analyst when a materially ambiguous
  meaning, inclusion/exclusion, time interpretation, or cleaning rule would change
  the result or become a reusable approved definition.
- Publisher-supplied text (the Kaggle description and any column dictionary inside
  it) arrives labelled `publisher-supplied`/`unverified`. It is a hypothesis to
  confirm with the analyst, never an approved definition: it may point at a
  question worth asking, but a publisher's column note does not resolve a business
  term, and it is not evidence about the values we actually loaded.

The briefing should name the source/version, coverage of each check, row grain,
date coverage, missingness, key and relationship evidence, rejected rows, and
unsupported files. Unknown or sample-only findings must remain visibly unknown.
