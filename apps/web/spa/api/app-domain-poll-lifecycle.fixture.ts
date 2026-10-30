import type { AppDomain } from '@repo/contract'

;(globalThis as { window?: EventTarget }).window = new EventTarget()
const [{ QueryClient, QueryObserver }, { appDomainQueryOptions }, { DuetApiClient }] =
  await Promise.all([import('@tanstack/react-query'), import('./app-domains'), import('./client')])
let calls = 0
let domain: AppDomain = {
  id: 'domain_1',
  workspaceId: 'ws_1',
  appId: 'app_1',
  hostname: 'portal.example.com',
  status: 'pending',
  records: [],
  conflicts: [],
  createdAt: 1,
  updatedAt: 1,
}
const api = new DuetApiClient(async () => {
  calls++
  return Response.json({ domain })
})
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
client.mount()
const observer = new QueryObserver(client, appDomainQueryOptions(api, 'acme', 'site'))
let unsubscribe = observer.subscribe(() => {})
try {
  await waitFor(() => calls === 1)
  domain = { ...domain, status: 'active' }
  await waitFor(() => observer.getCurrentResult().data?.domain?.status === 'active')
  await delay(2_200)
  if (Number(calls) !== 2) throw new Error('Active domain continued polling')
  unsubscribe()
  domain = { ...domain, status: 'failed' }
  await delay(2_200)
  if (Number(calls) !== 2) throw new Error('Domain polling continued after unmount')
  unsubscribe = observer.subscribe(() => {})
  await waitFor(() => observer.getCurrentResult().data?.domain?.status === 'failed')
  await delay(2_200)
  if (Number(calls) !== 3) throw new Error('Failed domain continued polling')
  domain = { ...domain, status: 'removing', retryRequired: true }
  await observer.refetch()
  await delay(2_200)
  if (Number(calls) !== 4) throw new Error('Exhausted cleanup continued polling')
  domain = { ...domain, status: 'removing', retryRequired: undefined, operatorRepairRequired: true }
  await observer.refetch()
  await delay(2_200)
  if (Number(calls) !== 5) throw new Error('Operator-required domain continued polling')
  console.log(
    JSON.stringify({
      calls,
      status: observer.getCurrentResult().data?.domain?.status,
      operatorRepairRequired: observer.getCurrentResult().data?.domain?.operatorRepairRequired,
    }),
  )
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
  throw new Error('Domain observation did not arrive')
}
