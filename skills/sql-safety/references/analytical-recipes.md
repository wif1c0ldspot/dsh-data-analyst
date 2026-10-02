## Packaged reference: analytical recipes

These examples use DuckDB through the authorized query service and match the
tested recipe builders. Replace only validated table/column identifiers and bind
ordinary values. DECIMAL/BIGINT inputs, extrema, counts, and sums remain typed;
DuckDB division, averages, and continuous quantiles can return DOUBLE values.
Keep the raw typed values and round derived display values only for presentation.

Supported functions (generated from the query-policy service):
`{{SUPPORTED_SQL_FUNCTIONS}}`

### Date parts and blank-string checks

`year(col)` and `trim(col)` are not on the allowlist; use the already-allowed
forms below instead of retrying with the denied spelling.

```
-- Year/month/day extraction: EXTRACT normalizes to the allowed date_part.
SELECT EXTRACT(YEAR FROM "order_date") AS order_year,
       sum("value") AS total_sales
FROM "analytical_fixture"
GROUP BY order_year
ORDER BY order_year
```

```
-- Blank-or-missing filter: compare the raw value instead of trim()ing it.
SELECT count(*) AS total_count
FROM "analytical_fixture"
WHERE "comparison_group" IS NOT NULL AND "comparison_group" <> ''
```

`col = ''` / `col <> ''` only replaces a `trim(col) = ''` blank check; it is
not a substitute for trimming padded values before grouping or joining.

### Grouping numeric dimensions

For category comparisons (e.g. median measure by bedroom count), `GROUP BY` the
raw dimension values. Do not invent half-unit bins unless the analyst asked for
binned ranges. Disclose NULL handling. Discrete-ness comes from observed values /
result evidence, not the column name.

### Fixed-width elapsed intervals

Declare width and origin. The recipe requires a verified integer elapsed column
up to 64 bits; 128-bit `HUGEINT`/`UHUGEINT` inputs are rejected because subtracting
the origin could exceed the working type. It uses exact `HUGEINT`
quotient/remainder arithmetic for stable `[start,end)` membership, including
negative values beyond the JavaScript safe-integer range; NULL inputs remain NULL.
Elapsed seconds do not establish a clock timezone. Treat a first or final partial
observation period as partial; the bin count does not normalize unequal exposure
windows.

```sql
WITH interval_values AS (
  SELECT CAST("elapsed_seconds" AS HUGEINT) - CAST(? AS HUGEINT) AS offset_seconds,
         CAST(? AS HUGEINT) AS width_seconds
  FROM "analytical_fixture"
  WHERE "elapsed_seconds" IS NOT NULL
), indexed AS (
  SELECT CASE
           WHEN offset_seconds < 0 AND offset_seconds % width_seconds <> 0
             THEN offset_seconds // width_seconds - 1
           ELSE offset_seconds // width_seconds
         END AS interval_index
  FROM interval_values
)
SELECT interval_index,
       count(*) AS row_count
FROM indexed
GROUP BY interval_index
ORDER BY interval_index
```

Bind `originSeconds`, then positive `widthSeconds`. NULLs are excluded from bins;
run the descriptive recipe on the elapsed column and disclose its `null_count`
beside the bins.

### Descriptive statistics

Report total and non-NULL counts with the statistics. DuckDB `quantile_cont`
uses continuous interpolation; the sample size and skew remain material. Without
an approved business grain, these describe source rows only. Quartiles and IQR
outlier flags are diagnostics, not automatic deletion rules.
Mean and median are supported descriptive findings when resolved from this recipe
result; they do not justify calling a distribution heavy-tailed.
The recipe uses approved logical-type metadata and withholds derived distribution
values for DECIMAL precision above 15 because DuckDB can interpolate those values
through binary floating point and cast a misleading result back to DECIMAL. Exact
counts and extrema remain available with `WITHHELD_HIGH_PRECISION_DECIMAL`.

```sql
SELECT count(*) AS total_count,
       count("value") AS non_null_count,
       count(*) - count("value") AS null_count,
       (count(*) - count("value")) / nullif(count(*), 0) AS null_share,
       min("value") AS min_value,
       max("value") AS max_value,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE avg("value") END AS mean_value,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE median("value") END AS median_value,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE quantile_cont("value", 0.25) END AS first_quartile,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE quantile_cont("value", 0.75) END AS third_quartile,
       CASE
         WHEN count("value") = 0 THEN 'NO_NON_NULL_VALUES'
         WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN 'WITHHELD_UNSAFE_DOUBLE_PRECISION'
         ELSE 'DERIVED_DOUBLE'
       END AS distribution_precision
FROM "analytical_fixture"
```

### Full-row duplicate excess

Supply every approved table column. Excess duplicates are total rows minus
distinct complete rows; do not substitute a business key or treat valid repeated
events as errors.

```sql
WITH row_counts AS (
  SELECT count(*) AS row_count
  FROM "analytical_fixture"
  GROUP BY "elapsed_seconds", "value", "numerator", "denominator", "comparison_group"
)
SELECT coalesce(sum(row_count), 0) AS total_count,
       count(*) AS distinct_row_count,
       coalesce(sum(row_count - 1), 0) AS duplicate_excess
FROM row_counts
```

### Ratio of sums

Define numerator and denominator populations and choose a reviewed NULL rule. The
shown `withhold-on-incomplete-pairs` form reports partial rows and withholds the
rate. The alternate tested form excludes incomplete pairs explicitly. A zero
aggregate denominator is undefined and remains NULL. Do not average subgroup
rates for a population rate; use approved grains before joining numerator and
denominator sources. For two established fractional rates, percentage-point
difference is `(new - old) * 100` (0.10 to 0.12 is 2 percentage points). If the
stored values are already percentages, subtract directly (10 to 12 is 2
percentage points). Relative change is `(new - old) / old` (20% in both
examples); do not compute it from a zero baseline. DuckDB division returns an
approximate DOUBLE here, so retain and report the exact numerator and denominator
sums and do not describe the derived ratio as exact.

```sql
SELECT count(*) AS total_count,
       count(*) - count(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN 1 ELSE NULL END) AS incomplete_pair_count,
       sum(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN "numerator" ELSE NULL END) AS numerator_sum,
       sum(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN "denominator" ELSE NULL END) AS denominator_sum,
       CASE
         WHEN count(*) - count(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN 1 ELSE NULL END) > 0 THEN NULL
         ELSE sum(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN "numerator" ELSE NULL END) / nullif(sum(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN "denominator" ELSE NULL END), 0)
       END AS population_rate,
       CASE
         WHEN count(*) - count(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN 1 ELSE NULL END) > 0 THEN 'INCOMPLETE_PAIRS'
         WHEN sum(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN "denominator" ELSE NULL END) IS NULL THEN 'NO_COMPLETE_PAIRS'
         WHEN sum(CASE WHEN "numerator" IS NOT NULL AND "denominator" IS NOT NULL THEN "denominator" ELSE NULL END) = 0 THEN 'ZERO_DENOMINATOR'
         ELSE NULL
       END AS undefined_reason
FROM "analytical_fixture"
```

### Explicit group comparison

Keep the counts beside each group result. A difference in means does not imply a
difference in medians or establish causality.

```sql
SELECT "comparison_group" AS comparison_group,
       count(*) AS total_count,
       count("value") AS non_null_count,
       count(*) - count("value") AS null_count,
       (count(*) - count("value")) / nullif(count(*), 0) AS null_share,
       min("value") AS min_value,
       max("value") AS max_value,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE avg("value") END AS mean_value,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE median("value") END AS median_value,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE quantile_cont("value", 0.25) END AS first_quartile,
       CASE WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN NULL ELSE quantile_cont("value", 0.75) END AS third_quartile,
       CASE
         WHEN count("value") = 0 THEN 'NO_NON_NULL_VALUES'
         WHEN min("value") < -9007199254740991 OR max("value") > 9007199254740991 THEN 'WITHHELD_UNSAFE_DOUBLE_PRECISION'
         ELSE 'DERIVED_DOUBLE'
       END AS distribution_precision
FROM "analytical_fixture"
GROUP BY "comparison_group"
ORDER BY "comparison_group"
```

### Top-N / extrema

Rank by one approved numeric measure and return a bounded top or bottom slice
(N capped at 50). With a grouping column, this ranks summed values per
distinct group; without one, it ranks individual rows and projects every
approved column. Both shapes append an explicit ascending tiebreaker so ties
at the boundary resolve the same way on every run — the recipe's own
`ORDER BY` means the authorized-query service's separate stabilizer never
applies here.

```sql
SELECT "comparison_group" AS dimension_value,
       sum("value") AS aggregate_value,
       count(*) AS row_count
FROM "analytical_fixture"
WHERE "value" IS NOT NULL
GROUP BY "comparison_group"
ORDER BY sum("value") DESC, "comparison_group" ASC
LIMIT 5
```
