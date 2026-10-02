import { z } from 'zod'

/** Domain types with Zod schemas for the initial query/chart input boundaries. */
export const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type Id = string
export type JsonScalar = z.infer<typeof JsonScalarSchema>
export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'validating'
  | 'loading'
  | 'profiling'
  | 'needs-input'
  | 'ready'
  | 'failed'
  | 'cancelled'

export interface DatasetManifest {
  contractVersion: 1
  datasetId: Id
  datasetVersionId: Id
  source: {
    slug: string
    version: string
    url: string
    retrievedAt: string
    license: string | null
  }
  files: Array<{ name: string; sha256: string; bytes: number; format: string }>
  recipeHash: string
  importerVersion: string
  tables: Array<{
    id: Id
    sourceFile: string
    rows: number
    rejectedRows: number
    /** Physical source data rows (adapter-defined); set for adaptive ingest. */
    sourceRowCount?: number
    /** Lossless raw_* table row count. */
    rawRowCount?: number
    /** Typed projection row count (must equal raw when adaptive). */
    projectionRowCount?: number
    /** Per-column TRY_CAST nulls introduced in the projection. */
    castNullCounts?: Record<string, number>
    loadStrategy?: 'typed_recipe' | 'raw_then_typed'
    /** String columns whose distinct values are 2+ ISO-4217 currency codes. */
    currencyDimensions?: Array<{ column: string; currencies: string[] }>
    /** Columns the bounded currency scan skipped: above the distinct-value cap, sampled values all ISO-4217 codes. */
    currencyScanSkipped?: Array<{ column: string; sampledDistinctValues: number }>
    /** Columns republished as raw VARCHAR because no value parsed as the approved type. */
    typeFallbacks?: Array<{ column: string; approvedType: string; unparsedValues: number }>
  }>
}

/** Structural validation only. SQL authorization/parsing is a separate service. */
export const QueryRequestSchema = z.strictObject({
  datasetVersionId: z.string().min(1),
  semanticRevisionId: z.string().min(1),
  sql: z.string().min(1).max(65_536),
  parameters: z
    .array(
      z.strictObject({
        logicalType: z.string().min(1),
        value: JsonScalarSchema,
      }),
    )
    .max(1_000),
})
export type QueryRequest = z.infer<typeof QueryRequestSchema>

export interface QueryResultSummary {
  resultId: Id
  datasetVersionId: Id
  semanticRevisionId: Id
  columns: Array<{ name: string; logicalType: string; unit?: string }>
  rowCount: number
  preview: JsonScalar[][]
  previewTruncated: boolean
  /** A capped result cannot be represented as a successful complete result. */
  resultComplete: true
  elapsedMs: number
  warnings: string[]
}

/** Intent only: no URLs, external data, HTML, or executable Vega expressions. */
/** Bounded presentation choices; never interpreted as code or data semantics. */
export const ChartFormatSchema = z.strictObject({
  xLabel: z.string().max(120).optional(),
  yLabel: z.string().max(120).optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  palette: z.enum(['tableau10', 'colorblind', 'dark2']).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  seriesColors: z
    .array(
      z.strictObject({
        value: z.union([z.string().max(200), z.number().finite(), z.boolean()]),
        color: z.string().regex(/^#[0-9a-f]{6}$/i),
      }),
    )
    .max(20)
    .optional(),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  xTicks: z.enum(['auto', 'integer', 'year']).optional(),
  legend: z.enum(['right', 'bottom', 'none']).optional(),
})

export const ChartIntentSchema = z
  .strictObject({
    mark: z.enum([
      'bar',
      'line',
      'point',
      'area',
      'heatmap',
      'boxplot',
      'histogram',
      'table',
      'kpi',
    ]),
    title: z.string().min(1).max(200),
    format: ChartFormatSchema.optional(),
    x: z.string().min(1).optional(),
    y: z.string().min(1).optional(),
    /** Optional second quantitative result field; compiled as a trusted two-layer chart. */
    y2: z.string().min(1).optional(),
    /** Quantitative color value used only by the heatmap template. */
    value: z.string().min(1).optional(),
    series: z.string().min(1).optional(),
    /** Small-multiple field. Vega expressions and model-authored facet specs are not accepted. */
    facet: z.string().min(1).optional(),
    facetColumns: z.number().int().min(1).max(6).optional(),
    /** Stacking is available only for bar/area charts with a series field. */
    stack: z.enum(['zero', 'normalize']).optional(),
    sort: z
      .strictObject({
        field: z.string().min(1),
        direction: z.enum(['ascending', 'descending']),
      })
      .optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    y2Label: z.string().optional(),
    valueLabel: z.string().optional(),
  })
  .superRefine((intent, ctx) => {
    const issue = (message: string, path: PropertyKey[]) =>
      ctx.addIssue({ code: 'custom', message, path })
    if (intent.y2 && !['line', 'area'].includes(intent.mark)) {
      issue('y2 is supported only for line and area charts', ['y2'])
    }
    if (!['table', 'kpi'].includes(intent.mark) && !intent.x) {
      issue(`${intent.mark} requires an x field`, ['x'])
    }
    if (!['table', 'kpi', 'histogram'].includes(intent.mark) && !intent.y) {
      issue(`${intent.mark} requires a y field`, ['y'])
    }
    if (intent.y2 && (intent.series || intent.stack)) {
      issue('y2 cannot be combined with series or stack', ['y2'])
    }
    if (intent.value && intent.mark !== 'heatmap') {
      issue('value is supported only for heatmaps', ['value'])
    }
    if (intent.series && intent.mark === 'heatmap') {
      issue('series is not supported by the heatmap template; use facet instead', ['series'])
    }
    if (intent.mark === 'heatmap' && !intent.value) {
      issue('heatmap requires a quantitative value field', ['value'])
    }
    if (intent.stack && !['bar', 'area'].includes(intent.mark)) {
      issue('stack is supported only for bar and area charts', ['stack'])
    }
    if (intent.stack && !intent.series) {
      issue('stack requires a series field', ['stack'])
    }
    if (intent.facetColumns && !intent.facet) {
      issue('facetColumns requires a facet field', ['facetColumns'])
    }
    if (intent.y2Label && !intent.y2) {
      issue('y2Label requires a y2 field', ['y2Label'])
    }
    if (intent.valueLabel && !intent.value) {
      issue('valueLabel requires a value field', ['valueLabel'])
    }
  })
export type ChartIntent = z.infer<typeof ChartIntentSchema>

/**
 * Deterministic post-render layout validation contract. Produced only by
 * `dsh-data-viz`'s SVG geometry validator — never by model free text — so a
 * caller can tell a truthfully "delivery verified" chart apart from one that
 * merely rendered. Stable, bounded issue codes; no raw SVG travels in this
 * contract.
 */
export const ChartLayoutIssueCodeSchema = z.enum([
  /** Two text labels' estimated bounding boxes overlap each other or a plotted panel. */
  'text-collision',
  /** A label's estimated bounding box extends outside the rendered view box. */
  'label-out-of-bounds',
  /** A legend entry has an empty/whitespace label. */
  'blank-legend-label',
  /** The rendered canvas exceeds the bounded delivery-size cap. */
  'excessive-output-bounds',
  /**
   * Aggregated marks that collapse into (nearly) one geometry — an encoding meant
   * to aggregate emitted one mark per input row instead. Observed on a live
   * 2,454-row histogram rendered as 2,454 identical full-height bars, which the
   * geometry-only checks reported as layout-valid.
   */
  'degenerate-aggregate',
  /** The same shared axis title is rendered more than once (e.g. once per facet). */
  'duplicate-shared-title',
  /** An axis title's estimated text run is disproportionate to any bounded panel. */
  'oversized-axis-title',
  /** The SVG could not be parsed, or exceeded the bounded input size/element count. */
  'unreadable-svg',
])
export type ChartLayoutIssueCode = z.infer<typeof ChartLayoutIssueCodeSchema>

export const ChartLayoutRoleSchema = z.enum([
  'axis-title',
  'axis-label',
  'facet-title',
  'legend',
  'chart-title',
  'marks',
  'canvas',
])
export type ChartLayoutRole = z.infer<typeof ChartLayoutRoleSchema>

export const ChartLayoutDiagnosticSchema = z.strictObject({
  code: ChartLayoutIssueCodeSchema,
  role: ChartLayoutRoleSchema,
  message: z.string().max(400),
  remediation: z.string().max(400),
})
export type ChartLayoutDiagnostic = z.infer<typeof ChartLayoutDiagnosticSchema>

export const ChartLayoutValidationSchema = z.strictObject({
  /** True only when no diagnostics were produced; never set by model free text. */
  ok: z.boolean(),
  diagnostics: z.array(ChartLayoutDiagnosticSchema).max(20),
  bounds: z.strictObject({ width: z.number(), height: z.number() }),
})
export type ChartLayoutValidation = z.infer<typeof ChartLayoutValidationSchema>

/**
 * Bounded automatic chart-refinement attempt. Produced only by
 * `createChartArtifact` (`dsh-data-viz/chart-service.ts`), which permits
 * exactly one deterministic recompile of the *same* authorized result and
 * chart intent when the first render fails layout validation — mapping
 * specific issue codes to safe, bounded template changes (drop an explicit
 * facet-column override, null a duplicated shared row/column title, flip bar
 * orientation, move the legend). This is a single conditional retry, never a
 * loop, and it never re-queries or changes result identity/data values.
 *
 * `attempted` is false when the first render already passed validation or no
 * safe change maps to its diagnostics. `changes` describes what the retry
 * tried, in order. `resolvedCodes` lists issue codes present before the
 * retry and absent from the kept render after it. `remainingDiagnostics` is
 * always the diagnostics of whichever render (original or retry) was
 * actually written to the artifact store — so a caller reading this
 * alongside `layoutValidation` can never see a resolved failure reported as
 * a hidden success, nor an unresolved one reported as clean. No tool input
 * parameter anywhere sets any field of this shape.
 */
export const ChartRefinementAttemptSchema = z.strictObject({
  attempted: z.boolean(),
  changes: z.array(z.string().max(300)).max(10),
  resolvedCodes: z.array(ChartLayoutIssueCodeSchema).max(20),
  remainingDiagnostics: z.array(ChartLayoutDiagnosticSchema).max(20),
  /**
   * The kept render discarded a display choice the caller stated outright (an
   * explicit `format.orientation`), rather than only a default the service was
   * free to pick. True only when that retry was actually kept, so it marks a
   * chart that differs from the one asked for and must be disclosed to the
   * analyst rather than presented as what they requested.
   */
  overrodeRequestedFormat: z.boolean().optional(),
})
export type ChartRefinementAttempt = z.infer<typeof ChartRefinementAttemptSchema>

/**
 * Delivery-width profiles: a small, service-owned,
 * bounded enum of named delivery contexts — never a raw pixel width — so a
 * model or client can only select *where* a chart will be shown, never
 * dictate an arbitrary canvas size. `dsh-data-viz` (`chart.ts`,
 * `deliveryWidthPxForProfile`) maps each profile to a fixed internal pixel
 * width; no tool parameter anywhere accepts a numeric width directly.
 */
export const ChartDeliveryProfileSchema = z.enum([
  'chat-card',
  'sidebar-narrow',
  'sidebar-wide',
  'export',
])
export type ChartDeliveryProfile = z.infer<typeof ChartDeliveryProfileSchema>

/**
 * Truthful chart-completion state. This is
 * `make_chart`'s complete typed output contract: a `rendered` fact (always
 * `true` — a failed compile/render throws instead of ever producing this
 * shape), the layout validator's own diagnostic result for whichever render was
 * kept, and the refinement attempt that produced it — all attached
 * server-side by `createChartArtifact` right after `renderChartSvg` runs.
 * Deliberately has no field that could be read as "this is saved" or "this
 * is visible in Studio" — persistence is `save_analysis`'s contract
 * ({@link StudioAvailabilityCheckSchema} covers Studio availability) and no
 * tool input parameter anywhere sets `layoutValidation` or `refinement`;
 * both can only be produced by `dsh-data-viz`'s own validator/refinement
 * logic.
 */
export const ChartRenderStateSchema = z.strictObject({
  rendered: z.literal(true),
  layoutValidation: ChartLayoutValidationSchema,
  refinement: ChartRefinementAttemptSchema,
})
export type ChartRenderState = z.infer<typeof ChartRenderStateSchema>

/**
 * Studio-availability observation. Produced only by re-querying the same catalog data path
 * `/api/analyst/overview` (`packages/dsh-data-workbench/src/overview.ts`)
 * reads from — `listAnalysisRevisions`, deduplicated to one row per analysis
 * at its latest persisted revision — never inferred from a `save_analysis`
 * return value and never settable by any tool input parameter. A successful
 * `save_analysis` call proves persistence only; whether the same revision is
 * actually retrievable via the Studio overview route is a separate,
 * independently observed fact this schema carries.
 */
export const StudioAvailabilityCheckSchema = z.strictObject({
  analysisId: z.string().min(1),
  /** The revision the caller asked about; null means "latest, whatever that is". */
  requestedRevision: z.number().int().min(1).nullable(),
  /** The latest revision the overview route currently returns for this analysis, or null if absent entirely. */
  latestRevision: z.number().int().min(1).nullable(),
  availableInStudio: z.boolean(),
  checkedVia: z.literal('studio-overview-route'),
  checkedAt: z.string(),
})
export type StudioAvailabilityCheck = z.infer<typeof StudioAvailabilityCheckSchema>

/**
 * Live visual QA release gate. Reports chart-choice correctness (a caller-
 * supplied grade, e.g. from `runChartAppropriatenessEval`'s reference/model
 * comparison) and the layout validator's own visual-layout verdict as two independent
 * scores for the same case, exactly like `ChartRenderState`'s
 * `layoutValidation` is independent of any chart-choice judgement. Only
 * `deterministic-validator` (this package's own `validateChartLayoutSvg`,
 * no live model, no booted harness) is available in an environment without
 * a live model/harness connection; `studio-live-open` records that the
 * rendered artifact was actually opened in the pinned Studio seam by a live
 * run — never inferred, only set by a caller that performed that open.
 */
export const VisualLayoutQaCheckedViaSchema = z.enum([
  'deterministic-validator',
  'studio-live-open',
])
export type VisualLayoutQaCheckedVia = z.infer<typeof VisualLayoutQaCheckedViaSchema>

export const VisualLayoutQaCaseResultSchema = z.strictObject({
  caseId: z.string().min(1).max(200),
  /** Which known failure shape this case exercises, e.g. 'faceted-shared-title', 'oversized-axis-title', 'multi-series-legend'. */
  archetype: z.string().min(1).max(200),
  datasetId: z.string().min(1).max(200).nullable(),
  deliveryWidthPx: z.number().int().positive(),
  /** Identifier of the rendered/opened artifact, or null when no artifact-store write occurred (e.g. a pure in-memory render). */
  artifactId: z.string().min(1).max(200).nullable(),
  /**
   * Chart-choice correctness, kept structurally separate from
   * `visualLayout`. `scored: false` (with `ok: null`) means this case did
   * not carry a chart-choice reference/model grade to compare against —
   * never a silent pass.
   */
  chartChoice: z.strictObject({
    scored: z.boolean(),
    ok: z.boolean().nullable(),
  }),
  visualLayout: ChartLayoutValidationSchema,
  /** True only when a live run actually opened this artifact in the pinned Studio seam. */
  openedInStudio: z.boolean(),
  checkedVia: VisualLayoutQaCheckedViaSchema,
})
export type VisualLayoutQaCaseResult = z.infer<typeof VisualLayoutQaCaseResultSchema>

export const VisualLayoutQaReportSchema = z.strictObject({
  generatedAt: z.string(),
  /** Model that produced the graded chart choices, or null for a reference/deterministic-only run with no live model. */
  model: z.string().min(1).max(200).nullable(),
  /** Pinned harness/Studio build identifier a live run used, or null when no booted harness was available. */
  harnessLockVersion: z.string().min(1).max(200).nullable(),
  viewportWidths: z.array(z.number().int().positive()).min(1).max(20),
  cases: z.array(VisualLayoutQaCaseResultSchema).max(500),
  summary: z.strictObject({
    chartChoicePassRate: z.number().min(0).max(1).nullable(),
    visualLayoutPassRate: z.number().min(0).max(1),
    /** No case has a text-collision or label-out-of-bounds diagnostic. */
    zeroP0LayoutDefects: z.boolean(),
    anyOpenedInStudio: z.boolean(),
  }),
})
export type VisualLayoutQaReport = z.infer<typeof VisualLayoutQaReportSchema>

/**
 * Walkthrough observability: a compact, append-only
 * milestone in the analyst walkthrough — preview proposed, analyst approved,
 * dataset published, query completed, chart rendered, analysis persisted, or
 * Studio opened. Every field is an identifier, an enum, or a timestamp; never
 * raw rows, SVG, or free text. `actor` distinguishes a model-driven tool call
 * (`'agent'`), a deterministic backend fact (`'service'`) and an authenticated
 * Studio UI action (`'analyst-ui'`) — the latter is only ever set from the
 * trusted `/api/analyst/ingest-recipes/review` approval route, never from
 * model-supplied arguments, so "analyst approved" can never be narrated into
 * existence by the agent.
 */
export const WorkflowMilestoneTypeSchema = z.enum([
  'preview_proposed',
  'analyst_approved',
  'dataset_published',
  'query_completed',
  'chart_rendered',
  'analysis_persisted',
  'studio_opened',
])
export type WorkflowMilestoneType = z.infer<typeof WorkflowMilestoneTypeSchema>

export const WorkflowActorSchema = z.enum(['agent', 'service', 'analyst-ui'])
export type WorkflowActor = z.infer<typeof WorkflowActorSchema>

/**
 * A bounded, identifier-shaped receipt reference (a pin/job/result/artifact
 * id, an `analysisId:revision` pair, or similar) — never a JSON blob, a raw
 * row, or free text. The charset excludes quotes, braces, whitespace and `=`
 * so a credential-shaped (`key=value`) or serialized-row-shaped string can
 * never validate as a receipt id in the first place; this is enforced at the
 * point of storage, not only at read time.
 */
export const WorkflowReceiptIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'receiptId must be a bounded identifier, not a payload')

export const WorkflowTrailEntrySchema = z.strictObject({
  entryId: z.string().min(1).max(200),
  milestone: WorkflowMilestoneTypeSchema,
  actor: WorkflowActorSchema,
  /**
   * The best dataset identifier known at this milestone: the published
   * `datasetVersionId` once a version exists, or the prospective recipe
   * `datasetId` beforehand (preview/approval, before any version is
   * published). Null only when no dataset is implicated (should not occur
   * for the milestones this contract enumerates).
   */
  datasetVersionId: z.string().min(1).max(200).nullable(),
  analysisId: z.string().min(1).max(200).nullable(),
  receiptId: WorkflowReceiptIdSchema,
  recordedAt: z.string(),
})
export type WorkflowTrailEntry = z.infer<typeof WorkflowTrailEntrySchema>

export interface AnalysisRevision {
  contractVersion: 1
  analysisId: Id
  revision: number
  datasetVersionId: Id
  semanticRevisionId: Id
  question: string
  query: QueryRequest
  resultId: Id
  chart: ChartIntent
  artifactIds: Id[]
  createdAt: string
  /**
   * Generated interpretation draft (not verified facts). Absent on legacy revisions.
   */
  interpretation?: {
    findings?: string[]
    caveats?: string[]
    nextSteps?: string[]
  }
  /**
   * Analyst review of interpretation bound to result identity.
   * Style-only recharts may carry this forward when resultId and narrative text match.
   */
  interpretationReview?: {
    status: 'unreviewed' | 'approved' | 'rejected'
    /** Result identity at approval time — filter/data changes invalidate. */
    resultId: Id
    reviewedAt?: string
  }
}

export type FeedbackKind = 'preference' | 'sql-correction' | 'semantic-correction' | 'vote'
export type ReviewStatus = 'candidate' | 'approved' | 'revoked'

/** Structured aggregation intents for semantic metric candidates. */
export type MetricAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct'

export interface Feedback {
  feedbackId: Id
  analysisId: Id
  analysisRevision: number
  kind: FeedbackKind
  /** Populated from authenticated context, never trusted from model arguments. */
  actorId: Id
  createdAt: string
  status: ReviewStatus
  comment: string
}

/**
 * Analyst-facing chart-quality feedback: a direct "chart layout problem" report an
 * analyst files against a specific artifact and persisted analysis
 * revision — a bounded issue-type enum, never free-form text, so a caller
 * can filter/aggregate without parsing prose. `issueType` is a distinct,
 * analyst-facing vocabulary from `ChartLayoutIssueCodeSchema` (the
 * deterministic validator's own codes) because an analyst can flag
 * judgment calls — e.g. `wrong-orientation` — the validator has no code
 * for; {@link CHART_FEEDBACK_ISSUE_TO_LAYOUT_CODE} documents the closest
 * validator code for each type where one exists, so the two taxonomies stay
 * aligned rather than parallel and incompatible. `report_chart_issue`
 * (`dsh-data-workbench/plugin-tools.ts`) always creates a row with
 * `status: 'candidate'`; no tool input parameter anywhere sets `status`.
 * The record may later be surfaced as a candidate correction example for
 * human review, but it must never be auto-approved into reusable learning
 * evidence — approval remains a separate, explicit workbench service
 * action (`chart-feedback-review.ts`, mirroring `learning-review.ts` /
 * `ingest-recipe-review.ts`), consistent with the Learning v1.1 boundary in
 * docs/implementation.md item 1.
 */
export const ChartFeedbackIssueTypeSchema = z.enum([
  'overlap',
  'clipping',
  'unreadable-legend',
  'wrong-orientation',
  'excess-whitespace',
])
export type ChartFeedbackIssueType = z.infer<typeof ChartFeedbackIssueTypeSchema>

/**
 * Closest `ChartLayoutIssueCode` for each analyst-facing feedback
 * type, where a natural match exists; `null` when the analyst-facing type
 * captures a judgment the deterministic validator has no code for.
 */
export const CHART_FEEDBACK_ISSUE_TO_LAYOUT_CODE: Readonly<
  Record<ChartFeedbackIssueType, ChartLayoutIssueCode | null>
> = {
  overlap: 'text-collision',
  clipping: 'label-out-of-bounds',
  'unreadable-legend': 'blank-legend-label',
  'wrong-orientation': null,
  'excess-whitespace': 'excessive-output-bounds',
}

export const ChartFeedbackStatusSchema = z.enum(['candidate', 'approved', 'revoked'])

export const ChartFeedbackSchema = z.strictObject({
  feedbackId: z.string().min(1).max(200),
  /** Must reference an artifact actually attached to the analysis revision below. */
  artifactId: z.string().min(1).max(200),
  analysisId: z.string().min(1).max(200),
  analysisRevision: z.number().int().min(1),
  issueType: ChartFeedbackIssueTypeSchema,
  notes: z.string().max(1000).optional(),
  /** Always 'candidate' at creation; only the review route can advance it. */
  status: ChartFeedbackStatusSchema,
  /** Populated from authenticated context, never trusted from model arguments. */
  actorId: z.string().min(1).max(200),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
})
export type ChartFeedback = z.infer<typeof ChartFeedbackSchema>

/** Fixed-grid dashboard layout. */
export interface DashboardSlot {
  /** Responsive grid span; omitted means one column. */
  width?: 1 | 2
  analysisId: Id
  revision: number
  title: string
  /** Keys the card declares it can accept from a shared filter bar. */
  sharedFilterKeys: string[]
}

export interface DashboardLayout {
  slots: DashboardSlot[]
}

export const DashboardActiveFilterSchema = z.strictObject({
  column: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .max(128),
  value: z.string().max(200),
  scope: z.literal('saved-result'),
  appliedDashboardVersion: z.string().min(1).max(100),
  cards: z
    .array(
      z.strictObject({
        analysisId: z.string().min(1).max(128),
        baseRevision: z.number().int().positive(),
        status: z.enum(['changed', 'unmapped', 'unsupported']),
        filteredRevision: z.number().int().positive().optional(),
        reason: z.string().max(500).optional(),
      }),
    )
    .max(100),
})
export type DashboardActiveFilter = z.infer<typeof DashboardActiveFilterSchema>

export interface Dashboard {
  dashboardId: Id
  title: string
  layout: DashboardLayout
  /** Trusted snapshot of the active shared filter and exact restorable bases. */
  activeFilter?: DashboardActiveFilter
  /** Soft-delete flag; archived dashboards are recoverable via restore. */
  archived: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Proposed semantic alias awaiting operator review. Humans must approve in
 * SQLite before a candidate is reusable. Approved rows overlay in-code
 * revisions at runtime via `getEffectiveSemantics` (P1/P5 bridge); candidate
 * and revoked statuses never apply. Learning v1.1 may add retrieval ranking.
 */
export interface SemanticAliasCandidate {
  candidateId: Id
  datasetId: Id
  term: string
  expression: string
  description: string
  tableId: string
  /** Structured aggregation intent (when the term is an additive/aggregate measure). */
  aggregation?: MetricAggregation
  /** Display/currency unit for the measure (e.g. 'USD', 'count', 'days'). */
  units?: string
  /** Date/calendar column the measure is sliced by (time grain). */
  dateColumn?: string
  /** Human-reviewed inclusion/exclusion rule (e.g. "exclude returns"). */
  inclusion?: string
  status: ReviewStatus
  actorId: Id
  createdAt: string
  reviewedAt: string | null
}

/** Profiled evidence backing a grain or relationship candidate (never model-authored). */
export interface StructureEvidence {
  /** Grain: uniqueness ratio (distinct/rows) per candidate key column. */
  uniqueness?: Record<string, number>
  /** Grain: null share per candidate key column. */
  nullRatio?: Record<string, number>
  /** Relationship: distinct join-key counts and join coverage. */
  fromDistinct?: number
  toDistinct?: number
  matchedFrom?: number
  matchedTo?: number
  /** Relationship: max fan-out (distinct matches) per direction. */
  maxFromTo?: number
  maxToFrom?: number
  /** Human-readable explanation of the deterministic inference. */
  reason?: string
}

export interface GrainCandidate {
  candidateId: Id
  datasetId: Id
  tableId: string
  primaryKey: string[]
  grainDescription: string
  evidence: StructureEvidence
  status: ReviewStatus
  actorId: Id
  createdAt: string
  reviewedAt: string | null
}

export interface RelationshipCandidate {
  candidateId: Id
  datasetId: Id
  fromTable: string
  toTable: string
  fromColumns: string[]
  toColumns: string[]
  cardinality: '1:1' | '1:n' | 'n:1' | 'n:n'
  evidence: StructureEvidence
  status: ReviewStatus
  actorId: Id
  createdAt: string
  reviewedAt: string | null
}

export type StructureCandidate = GrainCandidate | RelationshipCandidate

/**
 * Human-reviewed SQL correction eligible for bounded few-shot retrieval.
 * Compatibility is exact for dataset, schema fingerprint and semantic revision;
 * candidate/revoked rows never enter a model prompt.
 */
export interface LearningExample {
  exampleId: Id
  analysisId: Id
  analysisRevision: number
  datasetId: Id
  datasetVersionId: Id
  schemaFingerprint: string
  semanticRevisionId: Id
  question: string
  correctedSql: string
  status: ReviewStatus
  actorId: Id
  createdAt: string
  reviewedAt: string | null
}
