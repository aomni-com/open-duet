import type { AppDomain } from '@repo/contract'

;(globalThis as { window?: EventTarget }).window = new EventTarget()
const [
  { QueryClient, QueryObserver },
  { appDomainQueryOptions, appDomainMutationOptions },
  { DuetApiClient },
] = await Promise.all([
  import('@tanstack/react-query'),
  import('./app-domains'),
  import('./client'),
])
const initialCheckedAt = Date.UTC(2026, 8, 30, 12)
let reads = 0
let domain: AppDomain = {
  id: 'domain_1',
  workspaceId: 'ws_1',
  appId: 'app_1',
  hostname: 'portal.example.com',
  status: 'active',
  records: [],
  conflicts: [],
  createdAt: initialCheckedAt - 60_000,
  updatedAt: initialCheckedAt,
  lastCheckedAt: initialCheckedAt,
}
const api = new DuetApiClient(async (_input, init) => {
  if (init?.method === 'POST') {
    domain = { ...domain, checking: true }
    return Response.json({ domain })
  }
  reads++
  return Response.json({ domain })
})
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
client.mount()
const observer = new QueryObserver(client, appDomainQueryOptions(api, 'acme', 'site'))
const unsubscribe = observer.subscribe(() => {})
const completed: Array<{ before: string; status: string; checkedAt: number }> = []
try {
  await waitFor(() => observer.getCurrentResult().data?.domain?.status === 'active')
  for (const status of ['active', 'failed'] as const) {
    if (status === 'failed') {
      domain = {
        ...domain,
        status,
        lastError: 'Domain verification could not be completed.',
        records: [],
        lastCheckedAt: initialCheckedAt + 10_000,
        updatedAt: initialCheckedAt + 10_000,
      }
      await observer.refetch()
    }
    const accepted = await api.recheckAppDomain('acme', 'site')
    await appDomainMutationOptions(client, 'acme', 'site').onSuccess(accepted)
    if (observer.getCurrentResult().data?.domain?.status !== status)
      throw new Error('Recheck changed the admitted domain status')
    const beforeQueuedRead = reads
    await waitFor(
      () => reads > beforeQueuedRead && observer.getCurrentResult().data?.domain?.checking === true,
    )
    const checkedAt = initialCheckedAt + (status === 'active' ? 1_000 : 11_000)
    domain = {
      ...domain,
      status: 'active',
      checking: undefined,
      lastError: undefined,
      lastCheckedAt: checkedAt,
      updatedAt: checkedAt,
      records: [{ type: 'CNAME', domain: domain.hostname, value: 'cname.vercel-dns.com' }],
    }
    await waitFor(() => observer.getCurrentResult().data?.domain?.lastCheckedAt === checkedAt)
    const result = observer.getCurrentResult().data!.domain!
    if (result.records[0]?.value !== 'cname.vercel-dns.com' || result.lastError !== undefined)
      throw new Error('Recheck did not observe successful DNS results')
    completed.push({ before: status, status: result.status, checkedAt: result.lastCheckedAt! })
    const settledReads = reads
    await delay(2_200)
    if (reads !== settledReads) throw new Error('Completed recheck continued polling')
  }
  console.log(JSON.stringify({ completed }))
} finally {
  unsubscribe()
  client.unmount()
  client.clear()
  delete (globalThis as { window?: EventTarget }).window
}
function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`Queued ${domain.status} recheck completion was not observed`)
}
