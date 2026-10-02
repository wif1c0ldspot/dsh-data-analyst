/**
 * Child-process entry for isolated queries. Receives one IPC message with the
 * AuthorizedQueryRequest payload (minus signal) and replies once.
 */
import { executeAuthorizedQuery, type AuthorizedQueryRequest } from './query-service.js'

process.on('message', async (message: AuthorizedQueryRequest) => {
  try {
    const result = await executeAuthorizedQuery(message)
    process.send?.({ ok: true, result })
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    // Structured reply was sent (ok or error). Exit 0 so parent treats IPC as
    // the authority; non-zero is reserved for crashes before a reply.
    process.exitCode = 0
    process.disconnect?.()
  }
})
