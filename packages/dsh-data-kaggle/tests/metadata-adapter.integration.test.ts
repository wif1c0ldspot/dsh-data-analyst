import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  fetchKaggleDatasetMetadata,
  fetchKaggleLatestVersion,
  fetchKagglePublicMetadata,
  KaggleAuthenticationError,
  KaggleDatasetNotFoundError,
  KaggleEndpointUnsupportedError,
  KaggleMetadataVersionMismatchError,
  parseKaggleDatasetMetadata,
  parseKaggleLatestVersion,
  parseKagglePublicMetadata,
  readKaggleDatasetMetadataPayload,
  readKagglePublicMetadataPayload,
} from '../src/metadata-adapter.js'
import { parsePublisherSuppliedMetadata } from '../src/publisher-metadata.js'

let directory: string
let executable: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-kaggle-metadata-'))
  executable = join(directory, 'kaggle-stub.mjs')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function writeStub(metadata: unknown): Promise<void> {
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const pathIndex = args.indexOf('-p')
writeFileSync(join(args[pathIndex + 1], 'dataset-metadata.json'), ${JSON.stringify(
      JSON.stringify(metadata),
    )})
writeFileSync(join(args[pathIndex + 1], 'metadata-argv.json'), JSON.stringify(args))
`,
    'utf8',
  )
  await chmod(executable, 0o755)
}

it('uses fixed metadata argv and returns a license only when the response verifies the version', async () => {
  await writeStub({
    id: 'owner/dataset',
    title: 'Dataset title',
    versionNumber: 2,
    licenses: [{ name: 'CC-BY-4.0' }],
  })
  const result = await fetchKaggleDatasetMetadata(
    { slug: 'owner/dataset', sourceVersion: '2', destinationDir: directory },
    { kaggleExecutable: executable },
  )
  expect(result).toEqual({
    slug: 'owner/dataset',
    sourceVersion: '2',
    title: 'Dataset title',
    observedLicense: 'CC-BY-4.0',
    observedSourceVersion: '2',
    versionVerified: true,
    verifiedLicense: 'CC-BY-4.0',
  })
  expect(JSON.parse(await readFile(join(directory, 'metadata-argv.json'), 'utf8'))).toEqual([
    'datasets',
    'metadata',
    'owner/dataset',
    '-p',
    directory,
  ])
})

it('does not make an unversioned observed license safe to persist', () => {
  expect(
    parseKaggleDatasetMetadata(
      { id: 'owner/dataset', licenses: [{ name: 'CC0-1.0' }] },
      'owner/dataset',
      '2',
    ),
  ).toMatchObject({
    observedLicense: 'CC0-1.0',
    observedSourceVersion: null,
    versionVerified: false,
    verifiedLicense: null,
  })
})

it('accepts the official Kaggle 2.2.4 nested metadata shape without inventing provenance', () => {
  expect(
    parseKaggleDatasetMetadata(
      {
        info: {
          datasetSlug: 'dataset',
          title: 'Live dataset title',
          licenses: [{ name: 'CC0: Public Domain' }],
        },
      },
      'owner/dataset',
      '2',
    ),
  ).toEqual({
    slug: 'owner/dataset',
    sourceVersion: '2',
    title: 'Live dataset title',
    observedLicense: 'CC0: Public Domain',
    observedSourceVersion: null,
    versionVerified: false,
    verifiedLicense: null,
  })
})

it('rejects a nested metadata payload for another dataset slug', () => {
  expect(() =>
    parseKaggleDatasetMetadata(
      { info: { datasetSlug: 'another-dataset', licenses: [{ name: 'CC0-1.0' }] } },
      'owner/dataset',
      '2',
    ),
  ).toThrow(/datasetSlug does not match/)
})

it('rejects metadata for a different source version', () => {
  expect(() =>
    parseKaggleDatasetMetadata(
      { id: 'owner/dataset', versionNumber: 3, licenses: [{ name: 'CC0-1.0' }] },
      'owner/dataset',
      '2',
    ),
  ).toThrow(KaggleMetadataVersionMismatchError)
})

it('parseKaggleLatestVersion returns the current version and license without an expected version', () => {
  expect(
    parseKaggleLatestVersion(
      {
        id: 'owner/dataset',
        title: 'Dataset title',
        versionNumber: 2,
        licenses: [{ name: 'CC-BY-4.0' }],
      },
      'owner/dataset',
    ),
  ).toEqual({
    slug: 'owner/dataset',
    title: 'Dataset title',
    sourceVersion: '2',
    license: 'CC-BY-4.0',
  })
})

it('parseKaggleLatestVersion reports a null version when the response omits it', () => {
  expect(
    parseKaggleLatestVersion(
      { id: 'owner/dataset', licenses: [{ name: 'CC0-1.0' }] },
      'owner/dataset',
    ),
  ).toMatchObject({
    sourceVersion: null,
    license: 'CC0-1.0',
  })
})

it('parseKaggleLatestVersion still rejects metadata for another slug', () => {
  expect(() =>
    parseKaggleLatestVersion({ info: { datasetSlug: 'another-dataset' } }, 'owner/dataset'),
  ).toThrow(/datasetSlug does not match/)
})

it('fetchKaggleLatestVersion runs the fixed metadata argv and returns the current version', async () => {
  await writeStub({
    id: 'owner/dataset',
    title: 'Dataset title',
    versionNumber: 5,
    licenses: [{ name: 'MIT' }],
  })
  const result = await fetchKaggleLatestVersion(
    { slug: 'owner/dataset', destinationDir: directory },
    { kaggleExecutable: executable },
  )
  expect(result).toEqual({
    slug: 'owner/dataset',
    title: 'Dataset title',
    sourceVersion: '5',
    license: 'MIT',
  })
  expect(JSON.parse(await readFile(join(directory, 'metadata-argv.json'), 'utf8'))).toEqual([
    'datasets',
    'metadata',
    'owner/dataset',
    '-p',
    directory,
  ])
})

function jsonResponse(status: number, body: unknown): typeof fetch {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }
  return (async () => response) as unknown as typeof fetch
}

it('fetchKagglePublicMetadata reads currentVersionNumber from the public view API', async () => {
  const result = await fetchKagglePublicMetadata('owner/dataset', {
    fetchImpl: jsonResponse(200, {
      ref: 'owner/dataset',
      title: 'Widgets',
      currentVersionNumber: 5,
      licenseName: 'CC0-1.0',
    }),
  })
  expect(result).toEqual({
    slug: 'owner/dataset',
    title: 'Widgets',
    sourceVersion: '5',
    license: 'CC0-1.0',
  })
})

it('classifies a missing dataset as KaggleDatasetNotFoundError (404)', async () => {
  await expect(
    fetchKagglePublicMetadata('owner/dataset', { fetchImpl: jsonResponse(404, {}) }),
  ).rejects.toThrow(KaggleDatasetNotFoundError)
})

it('classifies authentication failure as KaggleAuthenticationError (403)', async () => {
  await expect(
    fetchKagglePublicMetadata('owner/dataset', { fetchImpl: jsonResponse(403, {}) }),
  ).rejects.toThrow(KaggleAuthenticationError)
})

it('classifies an unavailable endpoint as KaggleEndpointUnsupportedError (500)', async () => {
  await expect(
    fetchKagglePublicMetadata('owner/dataset', { fetchImpl: jsonResponse(500, {}) }),
  ).rejects.toThrow(KaggleEndpointUnsupportedError)
})

it('returns a null version when the view API omits currentVersionNumber', async () => {
  const result = await fetchKagglePublicMetadata('owner/dataset', {
    fetchImpl: jsonResponse(200, { ref: 'owner/dataset', title: 'Widgets' }),
  })
  expect(result).toEqual({
    slug: 'owner/dataset',
    title: 'Widgets',
    sourceVersion: null,
    license: null,
  })
})

it('reads the publisher description from the same CLI payload it parses for version/license', async () => {
  // Shape observed live against kaggle==2.2.4 for `olistbr/brazilian-ecommerce`:
  // `info` carries datasetSlug/title/description/subtitle/keywords/licenses.
  await writeStub({
    info: {
      datasetSlug: 'dataset',
      title: 'Widgets',
      licenses: [{ name: 'CC0-1.0' }],
      subtitle: 'Anonymised widgets',
      keywords: ['retail', 'tabular'],
      description: [
        '# Widgets',
        '',
        '| Column | Description |',
        '| --- | --- |',
        '| `order_id` | Identifier of an order. |',
      ].join('\n'),
    },
  })

  const payload = await readKaggleDatasetMetadataPayload(
    { slug: 'owner/dataset', destinationDir: directory },
    { kaggleExecutable: executable },
  )
  const parsed = parseKaggleDatasetMetadata(payload, 'owner/dataset', '2')
  const publisher = parsePublisherSuppliedMetadata({ cliMetadata: payload })

  expect(parsed.title).toBe('Widgets')
  expect(publisher.provenance).toBe('publisher-supplied')
  expect(publisher.verification).toBe('unverified')
  expect(publisher.subtitle).toBe('Anonymised widgets')
  expect(publisher.keywords).toEqual(['retail', 'tabular'])
  expect(publisher.columnDictionary.map((entry) => entry.column)).toEqual(['order_id'])
  expect(publisher.columnDictionary[0]?.verification).toBe('unverified')
  // One command, one payload, still the fixed argv.
  expect(JSON.parse(await readFile(join(directory, 'metadata-argv.json'), 'utf8'))).toEqual([
    'datasets',
    'metadata',
    'owner/dataset',
    '-p',
    directory,
  ])
})

it('reads the publisher description from the validated public view payload', async () => {
  const payload = await readKagglePublicMetadataPayload('owner/dataset', {
    fetchImpl: jsonResponse(200, {
      ref: 'owner/dataset',
      title: 'Widgets',
      currentVersionNumber: 3,
      licenseName: 'CC0-1.0',
      descriptionNullable:
        '| Column | Description |\n| --- | --- |\n| `order_id` | Identifier of an order. |',
    }),
  })
  const resolved = parseKagglePublicMetadata(payload, 'owner/dataset')
  expect(resolved).toEqual({
    slug: 'owner/dataset',
    title: 'Widgets',
    sourceVersion: '3',
    license: 'CC0-1.0',
  })

  const publisher = parsePublisherSuppliedMetadata({ viewApi: payload })
  expect(publisher.sources).toEqual(['kaggle-view-api'])
  expect(publisher.columnDictionary.map((entry) => entry.column)).toEqual(['order_id'])
})

it('still refuses a public view payload for a mismatched ref, publisher text included', async () => {
  await expect(
    readKagglePublicMetadataPayload('owner/dataset', {
      fetchImpl: jsonResponse(200, { ref: 'someone/else', description: 'Another publisher text.' }),
    }),
  ).rejects.toThrow(KaggleDatasetNotFoundError)
})
