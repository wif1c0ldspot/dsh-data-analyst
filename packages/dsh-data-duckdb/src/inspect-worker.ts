/**
 * Isolated source-inspection worker (Phase 1): run DuckDB/exceljs inspection in
 * a scrubbed child process with a hard timeout so large Kaggle previews cannot
 * freeze the dsh host event loop.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hardStop, scrubWorkerEnv } from './query-worker.js'
import {
  DEFAULT_INSPECT_TIMEOUT_MS,
  type InspectableSourceFile,
  type InspectedIngestRecipe,
} from './source-inspector.js'

const WORKER_PATH = fileURLToPath(new URL('../dist/inspect-worker-child.js', import.meta.url))

export interface IsolatedInspectRequest {
  files: readonly InspectableSourceFile[]
  maxTables?: number
  timeoutMs?: number
  signal?: AbortSignal
  killGraceMs?: number
}

export async function inspectSourceFilesIsolated(
  filesOrRequest: IsolatedInspectRequest | readonly InspectableSourceFile[],
  options: { maxTables?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<InspectedIngestRecipe> {
  const payload: IsolatedInspectRequest = Array.isArray(filesOrRequest)
    ? { files: filesOrRequest as readonly InspectableSourceFile[], ...options }
    : { ...(filesOrRequest as IsolatedInspectRequest), ...options }

  if (payload.signal?.aborted) throw new Error('Isolated inspection aborted')

  const timeoutMs = payload.timeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS
  const killGraceMs = payload.killGraceMs ?? 2_000
  const child = fork(WORKER_PATH, [], {
    env: scrubWorkerEnv(),
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })

  return await new Promise<InspectedIngestRecipe>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Source inspection exceeded ${timeoutMs}ms; refuse oversized or pathological files and retry with a smaller archive`,
          ),
        ),
      )
      void hardStop(child, killGraceMs)
    }, timeoutMs)

    const onAbort = () => {
      clearTimeout(timer)
      settle(() => reject(new Error('Isolated inspection aborted')))
      void hardStop(child, killGraceMs)
    }
    payload.signal?.addEventListener('abort', onAbort, { once: true })

    child.on(
      'message',
      (message: { ok?: boolean; result?: InspectedIngestRecipe; error?: string }) => {
        clearTimeout(timer)
        payload.signal?.removeEventListener('abort', onAbort)
        if (message.ok && message.result) {
          settle(() => resolve(message.result!))
        } else {
          settle(() => reject(new Error(message.error ?? 'Isolated inspection failed')))
        }
        child.disconnect()
        child.kill('SIGTERM')
      },
    )
    child.on('error', (error) => {
      clearTimeout(timer)
      payload.signal?.removeEventListener('abort', onAbort)
      settle(() => reject(error))
    })
    child.on('exit', (code, signalName) => {
      setImmediate(() => {
        clearTimeout(timer)
        payload.signal?.removeEventListener('abort', onAbort)
        settle(() =>
          reject(
            new Error(
              `Isolated inspection worker exited early (code=${code}, signal=${signalName})`,
            ),
          ),
        )
      })
    })

    child.send({
      files: payload.files,
      maxTables: payload.maxTables,
    })
  })
}

export type { ChildProcess }
