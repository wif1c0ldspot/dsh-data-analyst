/**
 * Isolated query worker: run one policy-gated query in a child process
 * that receives only the dataset path + SQL over IPC and inherits a scrubbed
 * environment (no Kaggle/model credentials). Mount isolation for containers is
 * still a separate Compose concern; this proves process-boundary scrubbing and
 * hard-kill after interrupt grace.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AuthorizedQueryRequest, AuthorizedQuerySummary } from './query-service.js'

const ALLOWED_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'])

export function scrubWorkerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_ENV) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  // Never forward credential-bearing variables or NODE_OPTIONS (parent may set
  // --input-type/--experimental flags that break forked ESM workers).
  return env
}

export interface IsolatedQueryRequest extends AuthorizedQueryRequest {
  /** Grace period after AbortSignal before SIGKILL (default 2000ms). */
  killGraceMs?: number
  signal?: AbortSignal
}

/**
 * Always fork the built worker under dist/. Vitest loads this module from
 * src/, where query-worker-child.js does not exist beside the .ts source.
 * Production loads from dist/, and ../dist/query-worker-child.js still resolves.
 */
const WORKER_PATH = fileURLToPath(new URL('../dist/query-worker-child.js', import.meta.url))

export async function executeIsolatedQuery(
  request: IsolatedQueryRequest,
): Promise<AuthorizedQuerySummary> {
  if (request.signal?.aborted) {
    throw new Error('Isolated query aborted')
  }

  const killGraceMs = request.killGraceMs ?? 2_000
  const child = fork(WORKER_PATH, [], {
    env: scrubWorkerEnv(),
    // Parent may have been started with --input-type=module / vitest execArgv;
    // those flags break forked ESM file workers (ERR_INPUT_TYPE_NOT_ALLOWED).
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })

  return await new Promise<AuthorizedQuerySummary>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const onAbort = () => {
      // Settle abort first so exit-handler races don't replace the reason.
      settle(() => reject(new Error('Isolated query aborted')))
      void hardStop(child, killGraceMs)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    child.on(
      'message',
      (message: { ok?: boolean; result?: AuthorizedQuerySummary; error?: string }) => {
        request.signal?.removeEventListener('abort', onAbort)
        if (message.ok && message.result) {
          settle(() => resolve(message.result!))
        } else {
          settle(() => reject(new Error(message.error ?? 'Isolated query failed')))
        }
        child.disconnect()
        child.kill('SIGTERM')
      },
    )
    child.on('error', (error) => {
      request.signal?.removeEventListener('abort', onAbort)
      settle(() => reject(error))
    })
    child.on('exit', (code, signalName) => {
      // Defer so a concurrent IPC 'message' can settle first (send-then-exit race).
      setImmediate(() => {
        request.signal?.removeEventListener('abort', onAbort)
        settle(() =>
          reject(
            new Error(`Isolated query worker exited early (code=${code}, signal=${signalName})`),
          ),
        )
      })
    })

    const { signal: _signal, killGraceMs: _grace, ...payload } = request
    child.send(payload)
  })
}

/**
 * SIGTERM then wait; if still alive (exitCode === null), SIGKILL.
 * Do not gate SIGKILL on `child.killed` — that flag is true after SIGTERM
 * even when the process is still running.
 */
/**
 * SIGTERM then wait; if still alive, SIGKILL via process.kill(pid).
 * Do not gate SIGKILL on `child.killed` — that flag is true after SIGTERM
 * even when the process is still running. Also do not treat exitCode===null
 * alone as "running" after an 'exit' event: signal-terminated children keep
 * exitCode null and set signalCode instead.
 */
export async function hardStop(child: ChildProcess, graceMs: number): Promise<void> {
  if (!isChildRunning(child)) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ])
  if (!isChildRunning(child) || child.pid === undefined) return
  try {
    process.kill(child.pid, 'SIGKILL')
  } catch {
    // ESRCH — already exited between the check and kill.
  }
  await Promise.race([
    new Promise<void>((resolve) => {
      if (!isChildRunning(child)) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    }),
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(graceMs, 1_000))),
  ])
}

function isChildRunning(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false
  if (child.pid === undefined) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
}
