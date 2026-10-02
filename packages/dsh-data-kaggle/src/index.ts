// Registration verified against the published dsh pin. Download uses the fixed
// argv adapter; paths/credentials come from the operator workspace, not model args.
// Product resolve is approved workspace pins only — use preview_ingest_source first.
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MetadataStore } from 'dsh-data-core/metadata-store'
import { UnsupportedSourceError } from 'dsh-data-core/recipes/registry'
import { resolveSourcePin } from 'dsh-data-core/recipes/workspace-registry'
import { renderObserve, withObserveErrors, type ObserveKind } from 'dsh-data-core/tool-observe'
import { resolveWorkspacePaths } from 'dsh-data-core/workspace-paths'
import { defaultPinnedKaggleExecutable } from './download-adapter.js'
import { downloadDestinationForSlug, startKaggleDownloadJob } from './download-job.js'
import { parseKagglePublicMetadata, readKagglePublicMetadataPayload } from './metadata-adapter.js'
import {
  modelPublisherSuppliedMetadata,
  parsePublisherSuppliedMetadata,
  type ModelPublisherSuppliedMetadata,
} from './publisher-metadata.js'
import { searchKaggleSources } from './search-adapter.js'

export const name = 'dsh-data-kaggle'
export const inject = ['tools']

/** Delimited, capped, allowlisted observe text — replaces a raw JSON dump. */
function observeRender(kind: ObserveKind) {
  return (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: renderObserve(kind, value).text },
  ]
}

/**
 * The model-facing publisher block is a JSON-shaped projection (plain strings,
 * arrays and nested records — see `publisher-metadata.ts`), but its declared
 * interface carries no index signature, so it is narrowed once here at the tool
 * boundary instead of widening every field of the declared output schema.
 */
function publisherSuppliedJson(block: ModelPublisherSuppliedMetadata): JsonLikeValue {
  return block as unknown as JsonLikeValue
}

function resolveApprovedPin(slug: string) {
  const workspace = resolveWorkspacePaths()
  const store = new MetadataStore(workspace.catalogPath)
  try {
    return { pin: resolveSourcePin(slug, store.listWorkspaceSourcePins()), workspace, store }
  } catch (error) {
    store.close()
    throw error
  }
}

/**
 * Local structural stand-in for a JSON value (not imported from
 * `@deepseek-ai/dsh-util-values`, which is not a declared dependency here).
 * Lets a typed tool result narrow once at the tool boundary — the strict
 * `output.schema` above it — instead of escaping the whole schema contract
 * with `as never`.
 */
type JsonLikeValue =
  null | boolean | number | string | JsonLikeValue[] | { [key: string]: JsonLikeValue }

export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      name: 'search_kaggle_sources',
      description:
        'Search Kaggle for datasets by keyword (bounded, read-only). Returns up to 20 results with ref/title/size/lastUpdated/downloadCount/license. Use a returned ref as the slug for preview_ingest_source.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Search keywords, e.g. "global terrorism"',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            results: {
              type: 'array',
              required: true,
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        render: observeRender('catalog'),
      },
      execute: withObserveErrors(async (args, exec) => {
        const results = await searchKaggleSources(String(args.query), {
          kaggleExecutable: defaultPinnedKaggleExecutable(),
          signal: exec.signal,
        })
        return { results: results as unknown as Record<string, JsonLikeValue>[] }
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'resolve_kaggle_version',
      description:
        "Resolve a Kaggle owner/dataset slug to its current (latest) pinned version number and license, without downloading. Use this to obtain the sourceVersion that preview_ingest_source requires when the analyst has not named a version. Also returns publisherSupplied: the publisher's own description excerpt and column dictionary, quoted and labelled publisher-supplied/unverified — evidence to confirm with the analyst, never an approved definition or a metric/alias you may adopt.",
      parameters: {
        slug: { type: 'string', required: true, description: 'Kaggle owner/dataset slug' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slug: { type: 'string', required: true },
            title: { type: 'json', required: true },
            sourceVersion: { type: 'json', required: true },
            license: { type: 'json', required: true },
            publisherSupplied: { type: 'json', required: true },
          },
        },
        render: observeRender('catalog'),
      },
      execute: withObserveErrors(async (args, exec) => {
        const slug = String(args.slug)
        // Public view API carries currentVersionNumber where the CLI metadata
        // omits it; authentication/missing-dataset/endpoint failures surface as
        // typed errors, while a valid reply without a version is `sourceVersion:
        // null` (not an error) so the agent can ask the analyst for the version.
        // The same validated payload carries the publisher's description, so one
        // call serves both — the publisher block stays labelled and bounded.
        const payload = await readKagglePublicMetadataPayload(slug, { signal: exec.signal })
        const resolved = parseKagglePublicMetadata(payload, slug)
        return {
          slug: resolved.slug,
          title: resolved.title,
          sourceVersion: resolved.sourceVersion,
          license: resolved.license,
          publisherSupplied: publisherSuppliedJson(
            modelPublisherSuppliedMetadata(parsePublisherSuppliedMetadata({ viewApi: payload })),
          ),
        }
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'resolve_kaggle_source',
      description:
        'Resolve an analyst-approved Kaggle slug (or dataset id) to its pinned source version, license, and recipe. Fails closed until preview_ingest_source has an approved workspace pin. When the pin stored publisherSupplied, it returns that publisher text (description excerpt + column dictionary) still labelled publisher-supplied/unverified — evidence to confirm with the analyst, never an approved definition.',
      parameters: {
        slug: { type: 'string', required: true, description: 'Kaggle owner/dataset slug' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slug: { type: 'string', required: true },
            sourceVersion: { type: 'json', required: true },
            datasetId: { type: 'string', required: true },
            license: { type: 'json', required: true },
            sourceUrl: { type: 'json', required: true },
            recipeHash: { type: 'string', required: true },
            requiresDownload: { type: 'boolean', required: true },
            tables: {
              type: 'array',
              required: true,
              items: { type: 'string' },
            },
            publisherSupplied: { type: 'json' },
          },
        },
        render: observeRender('catalog'),
      },
      execute: withObserveErrors((args) => {
        const { pin, store } = resolveApprovedPin(String(args.slug))
        try {
          return {
            slug: pin.slug,
            sourceVersion: pin.sourceVersion,
            datasetId: pin.recipe.datasetId,
            license: pin.recipe.license,
            sourceUrl: pin.recipe.sourceUrl,
            recipeHash: pin.recipe.recipeHash,
            requiresDownload: pin.requiresDownload,
            tables: pin.recipe.tables.map((table) => table.tableId),
            ...(pin.recipe.publisherSupplied
              ? {
                  publisherSupplied: publisherSuppliedJson(
                    modelPublisherSuppliedMetadata(pin.recipe.publisherSupplied),
                  ),
                }
              : {}),
          }
        } finally {
          store.close()
        }
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'kaggle_download',
      description:
        'Request a versioned Kaggle download job for an analyst-approved pin. Downloaded files are not yet a ready dataset; call ingest_dataset to publish.',
      parameters: {
        slug: { type: 'string', required: true, description: 'Kaggle owner/dataset slug' },
        sourceVersion: {
          type: 'string',
          description:
            'Pinned Kaggle dataset version number (positive integer). Omit to use the approved pin version.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            jobId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: observeRender('ingest'),
      },
      execute: withObserveErrors(async (args, exec) => {
        let pin
        let store
        try {
          ;({ pin, store } = resolveApprovedPin(String(args.slug)))
        } catch (error) {
          if (error instanceof UnsupportedSourceError) throw error
          throw error
        }
        try {
          const sourceVersion = args.sourceVersion ? String(args.sourceVersion) : pin.sourceVersion
          const workspace = resolveWorkspacePaths()
          const kaggleExecutable = defaultPinnedKaggleExecutable()
          return await startKaggleDownloadJob({
            slug: pin.slug,
            sourceVersion,
            destinationDir: downloadDestinationForSlug(
              workspace.sourcesDir,
              pin.slug,
              sourceVersion,
            ),
            kaggleExecutable,
            signal: exec.signal,
            createJob: (input) => store.createImportJob(input),
            updateJobStatus: (jobId, status, options) => {
              store.updateImportJobStatus(
                jobId,
                status as 'downloading' | 'validating' | 'failed',
                options,
              )
            },
          })
        } finally {
          store.close()
        }
      }),
    }),
  )
}
