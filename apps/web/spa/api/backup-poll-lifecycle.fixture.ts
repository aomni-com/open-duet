import type { Backup } from '@repo/contract'

import type { SpaApi } from '../context'

;(globalThis as { window?: EventTarget }).window = new EventTarget()
const [{ QueryClient, InfiniteQueryObserver }, { workspaceBackupsQueryOptions }] =
  await Promise.all([import('@tanstack/react-query'), import('./backups')])
let calls = 0
let status: Backup['status'] = 'queued'
const api = {
  listWorkspaceBackups: async () => {
    calls++
    return {
      items: [
        {
          id: 'backup-1',
          workspaceId: 'workspace-1',
          purpose: 'export' as const,
          status,
          createdAt: 1,
          updatedAt: 1,
          progress: {
            processedFiles: 0,
            processedRecords: 0,
            capturedBytes: 0,
            uploadedBytes: 0,
            warningCount: 0,
            warningSummary: [],
          },
        },
      ],
      nextCursor: null,
    }
  },
} satisfies Pick<SpaApi, 'listWorkspaceBackups'>
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
client.mount()
const observer = new InfiniteQueryObserver(client, workspaceBackupsQueryOptions(api, 'acme'))
let unsubscribe = observer.subscribe(() => {})
await waitFor(() => calls === 1)
unsubscribe()
status = 'running'
await new Promise(resolve => setTimeout(resolve, 2_200))
if (calls !== 1) throw new Error('Backup polling continued after unmount')
unsubscribe = observer.subscribe(() => {})
await waitFor(() => calls === 2)
status = 'ready'
await waitFor(() => calls === 3)
await new Promise(resolve => setTimeout(resolve, 2_200))
console.log(JSON.stringify({ calls, status: observer.getCurrentResult().data?.items[0]?.status }))
unsubscribe()
client.unmount()
client.clear()
delete (globalThis as { window?: EventTarget }).window

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Backup state did not arrive')
}
