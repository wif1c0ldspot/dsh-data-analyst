/** Reviewed, dataset-specific ingest recipe (trusted operator input — not model-authored). */
export interface RecipeColumn {
  name: string
  /** Original source label retained for review and non-CSV projection. */
  sourceName?: string
  type: string
}

export interface IngestTableRecipe {
  /** Exact entry name inside the validated zip. */
  sourceFile: string
  /** Controlled reader selected by trusted preview code; omitted means CSV for existing pins. */
  sourceFormat?: 'csv' | 'parquet' | 'json' | 'excel'
  tableId: string
  columns: readonly RecipeColumn[]
  dateFormat?: string
  timestampFormat?: string
  /** Worksheet name when sourceFormat is excel. */
  excelSheet?: string
  /** When set, rewrite the extracted CSV through this encoding before load. */
  sourceEncoding?: 'windows-1252' | 'utf-8' | 'utf-16le' | 'utf-16be'
  /**
   * Quality warnings the trusted preview raised for this table - ambiguous date
   * order, sample-only inference, a duplicated or blank source label, sheet
   * structure. Persisted with the proposal so the analyst's review shows the same
   * reasons the model was given instead of a bare type grid.
   */
  warnings?: readonly string[]
}

/**
 * How trusted ingest loads a generic (workspace) pin.
 * Absent / undefined means `typed_recipe` so existing approved pins keep
 * strict typed semantics (adaptive ingest design 2026-09-15).
 */
export type LoadStrategy = 'typed_recipe' | 'raw_then_typed'

/**
 * Provenance marker every publisher-supplied entry carries. Kaggle lets a
 * publisher write a free-text description (often including its own column
 * dictionary); none of it is verified against the data we actually load, and
 * none of it is reviewed. Reading it is evidence, not approval.
 */
export type PublisherSuppliedProvenance = 'publisher-supplied'

/** Verification marker: publisher-supplied text is never verified on our side. */
export type PublisherSuppliedVerification = 'unverified'

export interface PublisherSuppliedColumnNote {
  provenance: PublisherSuppliedProvenance
  verification: PublisherSuppliedVerification
  /** Proposed table the publisher's own heading resolved to, only when unambiguous. */
  tableId?: string
  /** Column label exactly as the publisher wrote it — may match nothing we proposed. */
  column: string
  /** Publisher wording, bounded and whitespace-normalized: quoted, never paraphrased. */
  note: string
}

/**
 * Publisher-supplied source text: the Kaggle dataset description, subtitle,
 * keywords, and any column dictionary the publisher wrote inside that
 * description.
 *
 * This block exists to keep three things structurally distinct wherever a
 * payload is built: observed facts (our own profiling — recipe `tables`,
 * preview column proposals, manifests), publisher-supplied notes (this block,
 * every entry labelled and marked unverified), and analyst-approved
 * definitions (the semantic alias/metric store, reachable only through
 * `propose_metric` plus the authenticated analyst review). It is deliberately a
 * sibling of `tables` on the recipe rather than a field inside a column, so
 * publisher text can never be read as — or promoted into — an observed fact or
 * an approved definition.
 */
export interface PublisherSuppliedMetadata {
  provenance: PublisherSuppliedProvenance
  verification: PublisherSuppliedVerification
  /** One-line handling rule carried wherever this block is rendered. */
  caveat: string
  /** Which Kaggle endpoints supplied the text (observed, not inferred). */
  sources: readonly string[]
  subtitle?: string
  keywords?: readonly string[]
  description?: {
    /** Publisher markdown, bounded and normalized. */
    text: string
    truncated: boolean
    /** Length of the publisher's original text in code points. */
    sourceLength: number
  }
  /** Bounded column-dictionary entries extracted from the description. */
  columnDictionary: readonly PublisherSuppliedColumnNote[]
  /** Entries the description contained before the bounded cut. */
  columnDictionaryTotal: number
  /** Honest notes about what was absent or could not be captured. */
  notes: readonly string[]
}

export interface IngestRecipe {
  datasetId: string
  recipeHash: string
  importerVersion: string
  tables: readonly IngestTableRecipe[]
  license: string | null
  sourceUrl: string
  /**
   * Optional load contract. Only `raw_then_typed` enables lossless raw + typed
   * projection publish. Must be set on a **new** pin revision and approved
   * explicitly — never inferred for legacy pins.
   */
  loadStrategy?: LoadStrategy
  /**
   * Publisher-supplied description/column dictionary captured at preview time,
   * quoted verbatim, labelled unverified and stored as its own block. Never read
   * as an observed fact and never an approved definition (see
   * {@link PublisherSuppliedMetadata}). Absent for every pin approved before
   * this field existed.
   */
  publisherSupplied?: PublisherSuppliedMetadata
}

/** Resolve the effective load strategy; absent field stays strict typed. */
export function effectiveLoadStrategy(recipe: Pick<IngestRecipe, 'loadStrategy'>): LoadStrategy {
  return recipe.loadStrategy ?? 'typed_recipe'
}
