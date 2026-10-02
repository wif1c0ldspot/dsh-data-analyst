// Dual-face plugin: host registers make_chart + authenticated artifact bytes;
// the browser half (`client.js`) owns the keyed toolview. SVG stays off the
// model path — IDs only in tool output.
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ChartDeliveryProfileSchema, type ChartDeliveryProfile } from 'dsh-data-core/contracts'
import { renderObserve } from 'dsh-data-core/tool-observe'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { createChartArtifact } from './chart-service.js'
import { handleChartArtifactRequest } from './chart-artifact-fetch.js'
import { CHART_ARTIFACT_FETCH_PATH } from './chart-artifact-id.js'
import { handleChartRechartRequest } from './rechart.js'

export const name = 'dsh-data-viz'
export const inject = ['tools']

type HostConnectionFetch = {
  fetch: {
    register: (route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }) => () => Promise<void>
  }
}

function registerChartArtifactFetch(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as HostConnectionFetch | undefined
    if (!connection?.fetch?.register) return
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: CHART_ARTIFACT_FETCH_PATH,
          methods: ['GET', 'HEAD'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const workspace = resolveWorkspacePaths()
            return handleChartArtifactRequest(request, workspace.artifactsDir)
          },
        }),
      'dsh-data-viz: chart artifact fetch',
    )
  })
}

function registerChartRechart(ctx: Context): void {
  ctx.inject(['connection'], (webCtx) => {
    const connection = Reflect.get(webCtx, 'connection') as HostConnectionFetch | undefined
    if (!connection?.fetch?.register) return
    webCtx.effect(
      () =>
        connection.fetch.register({
          path: '/api/analyst/charts/rechart',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleChartRechartRequest(request),
        }),
      'dsh-data-viz: chart rechart',
    )
  })
}

export function apply(ctx: Context) {
  registerChartArtifactFetch(ctx)
  registerChartRechart(ctx)
  ctx.tools.register(
    defineTool({
      name: 'make_chart',
      description:
        'Create a server-compiled chart from an authorized result. Supports bounded bar, line, point, area, heatmap, boxplot, histogram, table, KPI, stack, facet, and two-measure templates; never accepts raw Vega. ' +
        'If the first render fails deterministic layout validation, the service may try exactly one bounded, deterministic template fix on its own (see the "refinement" output field) — this is never a second query and never a loop. ' +
        'When that fix is kept and `refinement.overrodeRequestedFormat` is true, the delivered chart is NOT the one that was asked for — a display choice stated outright (for example an explicit vertical orientation) was reversed to make it fit. Say so in your answer, quote the reason from refinement.changes, and let the analyst decide, rather than presenting the chart as the requested one. ' +
        'The result proves only that a valid artifact was rendered and passed (or failed) deterministic layout validation — it is never a claim that the chart was saved or is visible in Studio. ' +
        'Report the chart as "rendered and passed layout validation" (or the specific failing issue codes) and tell the analyst to open it in Studio to confirm the visual result; do not say it was visually verified or inspected until that has actually happened.',
      parameters: {
        resultId: { type: 'string', required: true },
        deliveryProfile: {
          type: 'string',
          enum: ['chat-card', 'sidebar-narrow', 'sidebar-wide', 'export'],
          description:
            'Named delivery context this chart will render at (defaults to chat-card). Never a pixel width — the service maps each profile to a fixed internal size.',
        },
        intent: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            mark: {
              type: 'string',
              required: true,
              enum: [
                'bar',
                'line',
                'point',
                'area',
                'heatmap',
                'boxplot',
                'histogram',
                'table',
                'kpi',
              ],
            },
            title: { type: 'string', required: true },
            x: { type: 'string' },
            y: { type: 'string' },
            y2: { type: 'string', description: 'Second measure for line/area only.' },
            value: { type: 'string', description: 'Quantitative heatmap color field.' },
            series: { type: 'string', description: 'Nominal color/stack series field.' },
            facet: { type: 'string', description: 'Small-multiple result field.' },
            facetColumns: {
              type: 'number',
              description: 'Small-multiple columns, integer 1 through 6.',
            },
            stack: { type: 'string', enum: ['zero', 'normalize'] },
            format: {
              type: 'object',
              additionalProperties: false,
              description:
                'Presentation only: colour/palette, horizontal bars for long labels, and xTicks. xTicks auto/omitted infers integer ticks when all X values are safe integers; use integer explicitly when overriding; use year only after confirmed year meaning.',
              properties: {
                color: {
                  type: 'string',
                  description: 'Single mark colour, six-digit hex e.g. #0072B2.',
                },
                palette: { type: 'string', enum: ['tableau10', 'colorblind', 'dark2'] },
                orientation: { type: 'string', enum: ['vertical', 'horizontal'] },
                xTicks: {
                  type: 'string',
                  enum: ['auto', 'integer', 'year'],
                  description:
                    'auto: infer from result values; integer: whole-number X ticks; year: year labels after confirmed year meaning.',
                },
                xLabel: { type: 'string' },
                yLabel: { type: 'string' },
                decimals: { type: 'number', description: 'Integer decimal places 0 through 6.' },
                legend: { type: 'string', enum: ['right', 'bottom', 'none'] },
              },
            },
            xLabel: { type: 'string' },
            yLabel: { type: 'string' },
            y2Label: { type: 'string' },
            valueLabel: { type: 'string' },
            sort: {
              type: 'object',
              additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                direction: { type: 'string', required: true, enum: ['ascending', 'descending'] },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            artifactId: { type: 'string', required: true },
            analysisRevisionId: { type: 'string' },
            // `rendered` is always `true` on a successful call (a
            // failed compile/render throws instead) and `layoutValidation`
            // is the layout validator's own verdict, attached server-side by
            // `createChartArtifact`. `refinement` is the bounded
            // automatic retry attempt, if any, that produced whichever
            // render `layoutValidation` describes. None of these three
            // fields is accepted as a tool *input* anywhere in this schema —
            // a model has no way to set any of them itself, and none carries
            // a persistence or Studio-availability claim.
            rendered: { type: 'boolean', required: true },
            layoutValidation: { type: 'object', required: true, additionalProperties: true },
            refinement: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderObserve('chart', value).text }],
        // IDs only — the dsh client toolview resolves SVG/PNG by artifactId.
        presentationMeta: (_args, value) => ({ artifactId: value.artifactId }),
      },
      async execute(args, exec) {
        const workspace = resolveWorkspacePaths()
        const deliveryProfile =
          args.deliveryProfile === undefined
            ? undefined
            : (ChartDeliveryProfileSchema.parse(args.deliveryProfile) as ChartDeliveryProfile)
        return await createChartArtifact({
          resultId: String(args.resultId),
          intent: args.intent,
          deliveryProfile,
          resultStoreDir: workspace.resultsDir,
          artifactStoreDir: workspace.artifactsDir,
          catalogPath: workspace.catalogPath,
          signal: exec.signal,
        })
      },
    }),
  )
}
