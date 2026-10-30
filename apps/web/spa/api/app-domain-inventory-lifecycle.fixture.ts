import type { AppDomain } from '@repo/contract'

;(globalThis as { window?: EventTarget }).window = new EventTarget()
const [
  { QueryClient, QueryObserver, InfiniteQueryObserver },
  { appDomainQueryOptions, workspaceAppDomainsQueryOptions, appDomainMutationOptions },
  { DuetApiClient },
] = await Promise.all([
  import('@tanstack/react-query'),
  import('./app-domains'),
  import('./client'),
])
const initialCheckedAt = Date.UTC(2026, 8, 30, 12)
let pointReads = 0
let collectionReads = 0
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
const api = new DuetApiClient(async (input, init) => {
  if (init?.method === 'POST') {
    domain = { ...domain, checking: true }
    return Response.json({ domain })
  }
  if (String(input).includes('/app-domains')) {
    collectionReads++
    return Response.json({
      items: [{ domain, app: { id: 'app_1', slug: 'site', controls: { manageDomain: true } } }],
      nextCursor: null,
    })
  }
  pointReads++
  return Response.json({ domain })
})
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
client.mount()
const inventory = new InfiniteQueryObserver(client, workspaceAppDomainsQueryOptions(api, 'acme'))
const slot = new QueryObserver(client, appDomainQueryOptions(api, 'acme', 'site'))
const unsubscribeInventory = inventory.subscribe(() => {})
const unsubscribeSlot = slot.subscribe(() => {})
try {
  await waitFor(() => inventory.getCurrentResult().data?.items[0]?.domain.status === 'active')
  const accepted = await api.recheckAppDomain('acme', 'site')
  await appDomainMutationOptions(client, 'acme', 'site').onSuccess(accepted)
  await waitFor(() => inventory.getCurrentResult().data?.items[0]?.domain.checking === true)
  unsubscribeSlot()
  const closedPointReads = pointReads
  domain = {
    ...domain,
    checking: undefined,
    lastError: undefined,
    lastCheckedAt: initialCheckedAt + 1_000,
    updatedAt: initialCheckedAt + 1_000,
    records: [{ type: 'CNAME', domain: domain.hostname, value: 'cname.vercel-dns.com' }],
  }
  await waitFor(
    () =>
      inventory.getCurrentResult().data?.items[0]?.domain.lastCheckedAt ===
      initialCheckedAt + 1_000,
  )
  const result = inventory.getCurrentResult().data!.items[0]!.domain
  const settledCollectionReads = collectionReads
  await delay(2_200)
  if (collectionReads !== settledCollectionReads)
    throw new Error('Settled inventory continued polling')
  if (pointReads !== closedPointReads) throw new Error('Closed manager continued point reads')
  console.log(
    JSON.stringify({
      hostname: result.hostname,
      status: result.status,
      checking: result.checking === true,
      checkedAt: result.lastCheckedAt,
      recordValue: result.records[0]?.value,
    }),
  )
} finally {
  unsubscribeSlot()
  unsubscribeInventory()
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
  throw new Error('Inventory did not observe completion after manager closed')
}
