/**
 * Coordinator catalog open helper: MetadataStore plus crash recovery for
 * interrupted import jobs (see "Data and approval flow" in
 * docs/architecture.md).
 */
import { MetadataStore } from './metadata-store.js'

export function openMetadataStore(path: string, recoveryMessage?: string): MetadataStore {
  const store = new MetadataStore(path)
  store.recoverInterruptedImportJobs(
    recoveryMessage ?? 'recovered interrupted import job on coordinator start',
  )
  return store
}
