import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  buildAnalyticalRecipe,
  normalizeTopNDirection,
  type AnalyticalRecipeInput,
  type AnalyticalRecipeScope,
} from '../src/analytical-recipes.js'

const scope: AnalyticalRecipeScope = {
  table: 'analytical_fixture',
  columns: ['elapsed_seconds', 'value', 'numerator', 'denominator', 'comparison_group'],
  columnTypes: {
    elapsed_seconds: 'BIGINT',
    value: 'DOUBLE',
    numerator: 'DECIMAL(18,2)',
    denominator: 'DECIMAL(18,2)',
    comparison_group: 'VARCHAR',
  },
  grainStatus: 'approved',
}

const documentedInputs: AnalyticalRecipeInput[] = [
  {
    kind: 'elapsed-intervals',
    elapsedColumn: 'elapsed_seconds',
    originSeconds: 0,
    widthSeconds: 3600,
  },
  { kind: 'descriptive-statistics', valueColumn: 'value' },
  { kind: 'full-row-duplicate-excess', rowColumns: scope.columns },
  {
    kind: 'ratio-of-sums',
    numeratorColumn: 'numerator',
    denominatorColumn: 'denominator',
    nullRule: 'withhold-on-incomplete-pairs',
  },
  {
    kind: 'descriptive-statistics',
    valueColumn: 'value',
    groupColumn: 'comparison_group',
  },
  {
    kind: 'top-n-extrema',
    measureColumn: 'value',
    groupColumn: 'comparison_group',
    direction: 'top',
    limit: 5,
  },
]

it('keeps every documented SQL example identical to its tested recipe builder', async () => {
  const reference = await readFile(
    new URL('../../../skills/sql-safety/references/analytical-recipes.md', import.meta.url),
    'utf8',
  )
  const documented = [...reference.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((match) =>
    match[1]!.trim(),
  )
  expect(documented).toEqual(
    documentedInputs.map((input) => buildAnalyticalRecipe(scope, input).sql),
  )
})

it('accepts only approved identifiers and fixed recipe shapes', () => {
  expect(
    buildAnalyticalRecipe(
      { ...scope, grainStatus: 'unknown' },
      { kind: 'descriptive-statistics', valueColumn: 'value' },
    ).kind,
  ).toBe('descriptive-statistics')
  expect(() =>
    buildAnalyticalRecipe(
      { ...scope, grainStatus: 'unknown' },
      {
        kind: 'ratio-of-sums',
        numeratorColumn: 'numerator',
        denominatorColumn: 'denominator',
        nullRule: 'exclude-incomplete-pairs',
      },
    ),
  ).toThrow(/approved numerator\/denominator table grain/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'descriptive-statistics',
      valueColumn: 'value); DELETE FROM analytical_fixture; --',
    }),
  ).toThrow(/approved internal SQL identifier/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'ratio-of-sums',
      numeratorColumn: 'numerator',
      denominatorColumn: 'unapproved',
      nullRule: 'exclude-incomplete-pairs',
    }),
  ).toThrow(/not in the approved scope/)
})

it('requires the complete approved row for duplicate excess', () => {
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'full-row-duplicate-excess',
      rowColumns: ['elapsed_seconds', 'value'],
    }),
  ).toThrow(/every approved table column/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'full-row-duplicate-excess',
      rowColumns: [...scope.columns, 'value'],
    }),
  ).toThrow(/every approved table column/)
})

it('bounds interval parameters and binds them as typed values', () => {
  const recipe = buildAnalyticalRecipe(scope, documentedInputs[0]!)
  expect(recipe.parameters).toEqual([
    { logicalType: 'BIGINT', value: '0' },
    { logicalType: 'BIGINT', value: '3600' },
  ])
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'elapsed-intervals',
      elapsedColumn: 'elapsed_seconds',
      originSeconds: 0,
      widthSeconds: 0,
    }),
  ).toThrow(/greater than zero/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'elapsed-intervals',
      elapsedColumn: 'elapsed_seconds',
      originSeconds: Number.MAX_SAFE_INTEGER,
      widthSeconds: 3600,
    }),
  ).toThrow(/recipe bound/)
  expect(() =>
    buildAnalyticalRecipe(
      {
        table: 'fractional_elapsed',
        columns: ['elapsed_seconds'],
        columnTypes: { elapsed_seconds: 'DECIMAL(18,2)' },
        grainStatus: 'unknown',
      },
      {
        kind: 'elapsed-intervals',
        elapsedColumn: 'elapsed_seconds',
        originSeconds: 0,
        widthSeconds: 3600,
      },
    ),
  ).toThrow(/integer column type up to 64 bits/)
  for (const logicalType of ['HUGEINT', 'UHUGEINT']) {
    expect(() =>
      buildAnalyticalRecipe(
        {
          table: 'wide_elapsed',
          columns: ['elapsed_seconds'],
          columnTypes: { elapsed_seconds: logicalType },
          grainStatus: 'unknown',
        },
        {
          kind: 'elapsed-intervals',
          elapsedColumn: 'elapsed_seconds',
          originSeconds: 0,
          widthSeconds: 3600,
        },
      ),
    ).toThrow(/integer column type up to 64 bits/)
  }
})

it('normalizes common direction synonyms to the canonical top/bottom value, case-insensitively', () => {
  const topSynonyms = ['top', 'DESC', 'Descending', 'highest', 'LARGEST', 'max']
  for (const synonym of topSynonyms) {
    expect(normalizeTopNDirection(synonym)).toBe('top')
  }
  const bottomSynonyms = ['bottom', 'ASC', 'Ascending', 'lowest', 'SMALLEST', 'min']
  for (const synonym of bottomSynonyms) {
    expect(normalizeTopNDirection(synonym)).toBe('bottom')
  }
})

it('produces the same top-n-extrema SQL for a synonym as for the canonical direction', () => {
  const canonical = buildAnalyticalRecipe(scope, {
    kind: 'top-n-extrema',
    measureColumn: 'value',
    direction: normalizeTopNDirection('top'),
    limit: 3,
  })
  const viaSynonym = buildAnalyticalRecipe(scope, {
    kind: 'top-n-extrema',
    measureColumn: 'value',
    direction: normalizeTopNDirection('Descending'),
    limit: 3,
  })
  expect(viaSynonym).toEqual(canonical)

  const canonicalBottom = buildAnalyticalRecipe(scope, {
    kind: 'top-n-extrema',
    measureColumn: 'value',
    direction: normalizeTopNDirection('bottom'),
    limit: 3,
  })
  const viaAscSynonym = buildAnalyticalRecipe(scope, {
    kind: 'top-n-extrema',
    measureColumn: 'value',
    direction: normalizeTopNDirection('asc'),
    limit: 3,
  })
  expect(viaAscSynonym).toEqual(canonicalBottom)
})

it('rejects an unrecognized direction and lists the full accepted vocabulary', () => {
  expect(() => normalizeTopNDirection('sideways')).toThrow(
    /top, desc, descending, highest, largest, max, bottom, asc, ascending, lowest, smallest, min/,
  )
})

it('bounds top-n-extrema limit and requires an approved numeric measure', () => {
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'top-n-extrema',
      measureColumn: 'value',
      direction: 'top',
      limit: 0,
    }),
  ).toThrow(/integer between 1 and 50/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'top-n-extrema',
      measureColumn: 'value',
      direction: 'top',
      limit: 51,
    }),
  ).toThrow(/integer between 1 and 50/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'top-n-extrema',
      measureColumn: 'value',
      direction: 'top',
      limit: 1.5,
    }),
  ).toThrow(/integer between 1 and 50/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'top-n-extrema',
      measureColumn: 'comparison_group',
      direction: 'top',
      limit: 5,
    }),
  ).toThrow(/approved numeric measure column/)
  expect(() =>
    buildAnalyticalRecipe(scope, {
      kind: 'top-n-extrema',
      measureColumn: 'value); DROP TABLE analytical_fixture; --',
      direction: 'top',
      limit: 5,
    }),
  ).toThrow(/approved internal SQL identifier/)
})

it('produces an ungrouped top-n-extrema SQL shape with a full-row tiebreaker', () => {
  const recipe = buildAnalyticalRecipe(scope, {
    kind: 'top-n-extrema',
    measureColumn: 'value',
    direction: 'bottom',
    limit: 3,
  })
  expect(recipe.sql).toBe(
    `SELECT *\n` +
      `FROM "analytical_fixture"\n` +
      `WHERE "value" IS NOT NULL\n` +
      `ORDER BY "value" ASC, "comparison_group" ASC, "denominator" ASC, "elapsed_seconds" ASC, "numerator" ASC\n` +
      `LIMIT 3`,
  )
  expect(recipe.parameters).toEqual([])
})

it('requires verified type metadata for every approved column', () => {
  expect(() =>
    buildAnalyticalRecipe(
      { ...scope, columnTypes: {} },
      { kind: 'descriptive-statistics', valueColumn: 'value' },
    ),
  ).toThrow(/missing DuckDB logical type metadata/)
})
