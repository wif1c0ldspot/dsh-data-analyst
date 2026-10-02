/**
 * Child-process entry for bounded source inspection (Phase 1).
 * Keeps DuckDB / exceljs work off the dsh UI event loop.
 */
import { inspectSourceFilesInProcess, type InspectableSourceFile } from './source-inspector.js'

process.on('message', async (message: { files: InspectableSourceFile[]; maxTables?: number }) => {
  try {
    const result = await inspectSourceFilesInProcess(message.files, {
      maxTables: message.maxTables,
    })
    process.send?.({ ok: true, result })
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    process.exitCode = 0
    process.disconnect?.()
  }
})
