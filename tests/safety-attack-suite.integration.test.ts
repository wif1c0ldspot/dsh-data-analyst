/**
 * Safety / adversarial suite (see docs/architecture.md "Security and
 * deployment", tests/README.md).
 *
 * Every case expects deny / fail-closed. Suite size and named categories are
 * recorded in tests/README.md.
 * Synthetic fixtures only; no credentials; no model call.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import * as yazl from 'yazl'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChartIntentSchema } from '../packages/dsh-data-core/dist/contracts.js'
import { renderHtmlReport } from '../packages/dsh-data-core/dist/report-template.js'
import { QueryBudgetViolation } from '../packages/dsh-data-duckdb/dist/fixed-query.js'
import { executeAuthorizedQuery } from '../packages/dsh-data-duckdb/dist/query-service.js'
import { executeIsolatedQuery } from '../packages/dsh-data-duckdb/dist/query-worker.js'
import {
  authorizeQuery,
  QueryPolicyViolation,
} from '../packages/dsh-data-duckdb/dist/sql-policy.js'
import {
  ArchiveSafetyViolation,
  safeExtractZip,
  validateArchive,
} from '../packages/dsh-data-kaggle/dist/archive-safety.js'
import { compileChartIntent, renderChartSvg } from '../packages/dsh-data-viz/dist/chart.js'
import {
  createChartArtifact,
  resolveSafeResult,
} from '../packages/dsh-data-viz/dist/chart-service.js'
import { resolveSafeArtifact } from '../packages/dsh-data-workbench/dist/artifact-path.js'
import {
  createWorkbenchServer,
  isTrustedStateChangingRequest,
} from '../packages/dsh-data-workbench/dist/server.js'

const allowedTables = ['retail'] as const

let policyConnection: DuckDBConnection
let datasetPath: string
let datasetDirectory: string

beforeAll(async () => {
  const policyDb = await DuckDBInstance.create(':memory:')
  policyConnection = await policyDb.connect()
  await policyConnection.run(
    'CREATE TABLE retail (line_id VARCHAR, region VARCHAR, amount DECIMAL(18,2))',
  )

  datasetDirectory = await mkdtemp(join(tmpdir(), 'dsh-safety-dataset-'))
  datasetPath = join(datasetDirectory, 'dataset.duckdb')
  const writer = await DuckDBInstance.create(datasetPath)
  const connection = await writer.connect()
  try {
    await connection.run(
      `CREATE TABLE retail AS SELECT * FROM (VALUES
        ('1', 'West', 10.00::DECIMAL(18,2)),
        ('2', 'East', 20.00::DECIMAL(18,2)),
        ('3', 'North', 30.00::DECIMAL(18,2)),
        ('4', 'South', 40.00::DECIMAL(18,2))
      ) AS t(line_id, region, amount)`,
    )
    await connection.run('CHECKPOINT')
  } finally {
    connection.closeSync()
    writer.closeSync()
  }
})

afterAll(async () => {
  policyConnection.closeSync()
  await rm(datasetDirectory, { recursive: true, force: true })
})

async function expectPolicyDeny(sql: string): Promise<void> {
  await expect(
    authorizeQuery(policyConnection, sql, { allowedTables: [...allowedTables] }),
  ).rejects.toBeInstanceOf(QueryPolicyViolation)
}

function mockRequest(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as IncomingMessage
}

describe('[external-sql-io] external file/network reads via SQL', () => {
  it('[external-sql-io] denies read_csv filesystem path', async () => {
    await expectPolicyDeny("SELECT * FROM read_csv('/etc/passwd')")
  })

  it('[external-sql-io] denies read_parquet remote URL', async () => {
    await expectPolicyDeny("SELECT * FROM read_parquet('s3://bucket/key')")
  })

  it('[external-sql-io] denies httpfs-style read_csv_auto URL', async () => {
    await expectPolicyDeny("SELECT * FROM read_csv_auto('https://evil.example/data.csv')")
  })

  it('[external-sql-io] denies via executeIsolatedQuery (worker path)', async () => {
    await expect(
      executeIsolatedQuery({
        datasetPath,
        datasetVersionId: 'retail-v1',
        semanticRevisionId: 'sem-v1',
        sql: "SELECT * FROM read_csv('/etc/passwd')",
        parameters: [],
        allowedTables: [...allowedTables],
      }),
    ).rejects.toThrow(/Table functions|policy|SELECT|not allowed/i)
  })
})

describe('[sql-obfuscation-ddl-dml] SQL obfuscation, stacked statements, DDL/DML', () => {
  it('[sql-obfuscation-ddl-dml] denies stacked SELECT statements', async () => {
    await expectPolicyDeny('SELECT 1 FROM retail; SELECT 2 FROM retail')
  })

  it('[sql-obfuscation-ddl-dml] denies DELETE DML', async () => {
    await expectPolicyDeny('DELETE FROM retail')
  })

  it('[sql-obfuscation-ddl-dml] denies DROP / CREATE DDL', async () => {
    await expectPolicyDeny('DROP TABLE retail')
    await expectPolicyDeny('CREATE TABLE pwned (x INT)')
  })

  it('[sql-obfuscation-ddl-dml] denies ATTACH / COPY / INSTALL', async () => {
    await expectPolicyDeny("ATTACH 'other.db'")
    await expectPolicyDeny("COPY retail TO 'out.csv'")
    await expectPolicyDeny('INSTALL httpfs')
  })

  it('[sql-obfuscation-ddl-dml] denies comment-obfuscated stacked DDL', async () => {
    await expectPolicyDeny('SELECT 1 FROM retail; /* comment */ DROP TABLE retail')
  })

  it('[sql-obfuscation-ddl-dml] denies case-mixed non-SELECT', async () => {
    await expectPolicyDeny('dElEtE fRoM retail')
  })

  it('[sql-obfuscation-ddl-dml] denies unauthorized table even inside CTE', async () => {
    await expectPolicyDeny('WITH x AS (SELECT * FROM duckdb_tables()) SELECT * FROM x')
  })

  it('[sql-obfuscation-ddl-dml] denies via executeIsolatedQuery', async () => {
    await expect(
      executeIsolatedQuery({
        datasetPath,
        datasetVersionId: 'retail-v1',
        semanticRevisionId: 'sem-v1',
        sql: 'DELETE FROM retail',
        parameters: [],
        allowedTables: [...allowedTables],
      }),
    ).rejects.toThrow(/SELECT|policy|not allowed|Only a single/i)
  })
})

describe('[unauthorized-artifact-access] path traversal outside artifact store', () => {
  let artifactsDir: string

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-safety-art-'))
    artifactsDir = join(root, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })
    await writeFile(join(artifactsDir, 'art_ok.svg'), '<svg/>', 'utf8')
  })

  afterEach(async () => {
    await rm(join(artifactsDir, '..'), { recursive: true, force: true })
  })

  it('[unauthorized-artifact-access] resolveSafeArtifact denies ../ traversal', () => {
    expect(resolveSafeArtifact(artifactsDir, '../secret.svg')).toBeNull()
  })

  it('[unauthorized-artifact-access] resolveSafeArtifact denies absolute-looking and nested paths', () => {
    expect(resolveSafeArtifact(artifactsDir, 'foo/bar.svg')).toBeNull()
    expect(resolveSafeArtifact(artifactsDir, 'foo\\bar.svg')).toBeNull()
  })

  it('[unauthorized-artifact-access] resolveSafeResult denies invalid / traversal ids', () => {
    const resultsDir = join(artifactsDir, '..', 'results')
    expect(resolveSafeResult(resultsDir, '../etc/passwd')).toBeNull()
    expect(resolveSafeResult(resultsDir, 'res_../../secret')).toBeNull()
    expect(resolveSafeResult(resultsDir, 'res_foo/bar')).toBeNull()
  })

  it('[unauthorized-artifact-access] workbench GET denies encoded traversal', async () => {
    const server = createWorkbenchServer({
      workspace: {
        root: join(artifactsDir, '..'),
        catalogPath: join(artifactsDir, '..', 'catalog.sqlite'),
        resultsDir: join(artifactsDir, '..', 'results'),
        artifactsDir,
        analysesDir: join(artifactsDir, '..', 'analyses'),
        sourcesDir: join(artifactsDir, '..', 'sources'),
        datasetFile: () => join(artifactsDir, '..', 'missing.duckdb'),
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    try {
      const denied = await fetch(
        `http://127.0.0.1:${address.port}/analyst/artifacts/${encodeURIComponent('../x.svg')}`,
      )
      expect(denied.status).toBe(400)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

describe('[malicious-archives] archive traversal / bomb / symlink', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-safety-zip-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function buildZip(
    entries: Array<{ path: string; content?: string; mode?: number; rawName?: string }>,
  ): Promise<string> {
    const zipfile = new yazl.ZipFile()
    for (const entry of entries) {
      zipfile.addBuffer(
        Buffer.from(entry.content ?? 'x'),
        entry.path,
        entry.mode !== undefined ? { mode: entry.mode } : undefined,
      )
      if (entry.rawName !== undefined) {
        const internalEntries = (zipfile as unknown as { entries: { utf8FileName: Buffer }[] })
          .entries
        const added = internalEntries[internalEntries.length - 1]
        if (added) added.utf8FileName = Buffer.from(entry.rawName, 'utf8')
      }
    }
    const archivePath = join(directory, 'fixture.zip')
    const writeStream = createWriteStream(archivePath)
    zipfile.outputStream.pipe(writeStream)
    zipfile.end()
    await finished(writeStream)
    return archivePath
  }

  it('[malicious-archives] denies path-traversal entry', async () => {
    const archivePath = await buildZip([
      { path: 'placeholder.txt', rawName: '../escape.txt', content: 'x' },
    ])
    await expect(validateArchive(archivePath)).rejects.toBeInstanceOf(ArchiveSafetyViolation)
  })

  it('[malicious-archives] denies symlink entry', async () => {
    const archivePath = await buildZip([{ path: 'link', content: '/etc/passwd', mode: 0o120777 }])
    await expect(validateArchive(archivePath)).rejects.toThrow(/Symlink/)
  })

  it('[malicious-archives] denies zip-bomb expansion ratio', async () => {
    const archivePath = await buildZip([{ path: 'bomb.bin', content: '0'.repeat(2_000_000) }])
    await expect(
      validateArchive(archivePath, {
        maxFiles: 100,
        maxTotalUncompressedBytes: 1024 ** 3,
        maxExpansionRatio: 50,
      }),
    ).rejects.toThrow(/expansion ratio/)
  })

  it('[malicious-archives] extracts nothing when validation fails', async () => {
    const archivePath = await buildZip([
      { path: 'good.csv', content: 'a,b\n1,2\n' },
      { path: 'placeholder2.txt', rawName: '../escape.txt', content: 'x' },
    ])
    const outDir = join(directory, 'out')
    await expect(safeExtractZip(archivePath, outDir)).rejects.toBeInstanceOf(ArchiveSafetyViolation)
    await expect(readFile(join(outDir, 'good.csv'))).rejects.toThrow()
  })
})

describe('[chart-template-injection] chart intent / HTML template injection', () => {
  it('[chart-template-injection] ChartIntentSchema rejects URL data / expressions', () => {
    const chart = { mark: 'bar' as const, title: 'Revenue', x: 'region', y: 'revenue' }
    for (const injected of [
      { data: { url: 'https://evil.example/data' } },
      { calculate: 'datum.x + 1' },
      { transform: [{ filter: 'true' }] },
      { mark: 'image' },
      { href: 'javascript:alert(1)' },
    ]) {
      expect(ChartIntentSchema.safeParse({ ...chart, ...injected }).success).toBe(false)
    }
  })

  it('[chart-template-injection] createChartArtifact denies traversal result ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-safety-chart-'))
    try {
      await expect(
        createChartArtifact({
          resultId: '../etc/passwd',
          intent: { mark: 'bar', title: 'x', x: 'region', y: 'revenue' },
          resultStoreDir: join(directory, 'results'),
          artifactStoreDir: join(directory, 'artifacts'),
        }),
      ).rejects.toThrow(/Invalid result id|result id/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('[chart-template-injection] HTML report escapes script / markup in title and cells', () => {
    const html = renderHtmlReport({
      title: '<script>alert(1)</script>',
      svgMarkup: '<svg><text>ok</text></svg>',
      columns: [{ name: 'region', logicalType: 'VARCHAR' }],
      rows: [['<img src=x onerror=alert(1)>']],
      rowCount: 1,
      previewTruncated: false,
      sourceCaption: 'Synthetic',
      datasetVersionId: 'retail-v1',
      semanticRevisionId: 'sem-v1',
      generatedAt: '2026-09-13T00:00:00.000Z',
      warnings: ['<b>warn</b>'],
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/<script|https?:\/\//)
  })

  it('[chart-template-injection] rendered SVG has no script or remote href/src', async () => {
    const spec = compileChartIntent(
      {
        mark: 'bar',
        title: '<script>x</script>',
        x: 'region',
        y: 'revenue',
        xLabel: '"><img src=x>',
        yLabel: "javascript:alert('x')",
      },
      [
        { region: 'West', revenue: 10 },
        { region: 'East', revenue: 20 },
      ],
    )
    const svg = await renderChartSvg(spec)
    expect(svg).not.toMatch(/<script|<image|(?:href|src)=["']https?:/i)
  })
})

describe('[csrf-origin-host] Origin/Host CSRF rejection on state-changing routes', () => {
  it('[csrf-origin-host] isTrustedStateChangingRequest denies cross-origin Origin', () => {
    expect(
      isTrustedStateChangingRequest(
        mockRequest({ host: '127.0.0.1:8790', origin: 'http://evil.example' }),
      ),
    ).toBe(false)
  })

  it('[csrf-origin-host] isTrustedStateChangingRequest denies cross-site Sec-Fetch-Site', () => {
    expect(
      isTrustedStateChangingRequest(
        mockRequest({ host: '127.0.0.1:8790', 'sec-fetch-site': 'cross-site' }),
      ),
    ).toBe(false)
  })

  it('[csrf-origin-host] isTrustedStateChangingRequest allows same-origin Origin', () => {
    expect(
      isTrustedStateChangingRequest(
        mockRequest({ host: '127.0.0.1:8790', origin: 'http://127.0.0.1:8790' }),
      ),
    ).toBe(true)
  })

  it('[csrf-origin-host] workbench POST returns 403 for cross-origin state change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-safety-csrf-'))
    await mkdir(join(directory, 'artifacts'), { recursive: true })
    const server = createWorkbenchServer({
      workspace: {
        root: directory,
        catalogPath: join(directory, 'catalog.sqlite'),
        resultsDir: join(directory, 'results'),
        artifactsDir: join(directory, 'artifacts'),
        analysesDir: join(directory, 'analyses'),
        sourcesDir: join(directory, 'sources'),
        datasetFile: () => join(directory, 'missing.duckdb'),
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/dataset/superstore/query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          Origin: 'http://evil.example',
        },
        body: 'sql=SELECT+1',
      })
      expect(res.status).toBe(403)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('[query-budget-exhaustion] query budget denial', () => {
  it('[query-budget-exhaustion] denies result exceeding maxResultRows', async () => {
    await expect(
      executeAuthorizedQuery({
        datasetPath,
        datasetVersionId: 'retail-v1',
        semanticRevisionId: 'sem-v1',
        sql: 'SELECT line_id, region, amount FROM retail',
        parameters: [],
        allowedTables: [...allowedTables],
        maxResultRows: 1,
      }),
    ).rejects.toBeInstanceOf(QueryBudgetViolation)
  })

  it('[query-budget-exhaustion] denies result exceeding maxResultBytes', async () => {
    await expect(
      executeAuthorizedQuery({
        datasetPath,
        datasetVersionId: 'retail-v1',
        semanticRevisionId: 'sem-v1',
        sql: 'SELECT line_id, region, amount FROM retail',
        parameters: [],
        allowedTables: [...allowedTables],
        maxResultBytes: 8,
      }),
    ).rejects.toMatchObject({ name: 'QueryBudgetViolation' })
  })
})
