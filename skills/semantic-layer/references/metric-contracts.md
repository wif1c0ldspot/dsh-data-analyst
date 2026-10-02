## Packaged reference: metric contracts

A reusable metric review resolves or explicitly marks unknown each of the following:

- population and explicit inclusions/exclusions;
- input table grain, output grain, keys, and any relationship cardinality;
- unit and currency, including whether values are amounts, rates, percentages,
  percentage points, counts, or durations;
- time field, timezone when known, calendar, period boundaries, and observation
  window;
- aggregation rule and whether the measure is additive across each dimension;
- NULL rule, zero-denominator behavior, and treatment of returns/cancellations;
- for ratios, numerator and denominator expressions, populations, and units;
- proposal/approval status and available dataset/schema/semantic revision and
  review evidence.

Persist the fields the current semantic contract supports. Keep unsupported
semantics as explicit caveats; do not imply the service stores or enforces them.
Validate supported expressions and joins through the semantic service. Free-text
inclusion rules are documentation, never executable predicates. Many-to-many
joins, incomplete key coverage, mixed currencies, or unresolved time meaning need
an analyst decision when they can change the answer. Query success is not approval
evidence.
