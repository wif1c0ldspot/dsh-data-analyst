## Packaged reference: chart and delivery checks

- Match the encoding to the question: ordered time trend to line, category
  comparison to bar, two quantitative measures to point, distribution to
  histogram/boxplot, bounded two-dimensional magnitude to heatmap, and exact
  values to table/KPI.
- Stack only measures whose approved semantics are additive over the stack
  dimension. Rates, percentages, averages, medians, and distinct counts are not
  additive unless a validated numerator/denominator or other contract says how
  to recompute them.
- Keep raw exact values in accessible tables and exports. Apply consistent display
  precision only after calculation; state units and use percentage versus
  percentage-point wording correctly.
- Ground report quality statements in an explicit query result. Catalog `rows`
  and `rejectedRows` describe ingestion only; zero rejected rows is not evidence
  of no duplicates, no NULLs or a particular distribution shape.
- Prefer service-resolved computed findings (result/version identity, operation,
  exact value, units and filter/NULL scope). A result id beside free-text prose
  does not validate that prose. Default shareable reports to computed findings;
  include generated interpretation only after explicit analyst choice.
- Mean and median describe the stored result only; they do not establish a
  heavy-tailed distribution. Marginal summaries for separate fields do not
  establish joint separation, correlation, clusters or multivariate shape. Use
  paired row-level evidence and an inspected scatterplot, or a separately
  supported computation. A raw-field plot does not require proposing an aggregate
  metric alias.
- Use restrained colours or the colorblind palette. Do not encode meaning with
  colour alone, and do not assign good/bad meaning without an approved definition.
- Inspect labels, scales, ordering, clipping, empty states, and accessibility at
  the actual delivery size before describing a chart as visually verified.
- Use result evidence `integerDomain` / `distinctCount` for discrete vs continuous
  X decisions. Do not invent half-step category labels for whole-number domains.

Completion claims require service receipts: the returned saved revision, persisted
dashboard slot count, or export readiness/downloads. A successful query, proposed
action, or generated artifact ID does not prove that a save, pin, export, browser
render, or offline open succeeded. Report the observed state and any unverified
delivery step precisely.
