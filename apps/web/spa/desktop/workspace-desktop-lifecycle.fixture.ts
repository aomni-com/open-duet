import { DuetApiError } from '../api/client'
import type { SpaApi } from '../context'

const browserWindow = new EventTarget()
;(globalThis as { window?: EventTarget & { location?: { origin: string } } }).window =
  Object.assign(browserWindow, { location: { origin: 'https://app.duet.test' } })

const [{ onlineManager, QueryClient, QueryObserver }, { desktopSessionQueryOptions }] =
  await Promise.all([import('@tanstack/react-query'), import('./workspace-desktop')])

let calls = 0
const api = {
  mintDesktopSession: async () => {
    calls += 1
    if (calls === 1) throw new DuetApiError(401, 'unauthorized')
    return {
      entryUrl: `https://vm.test/v1/desktop/grant-${calls}.token/`,
      expiresAt: 1,
      phase: 'ready' as const,
      screen: { width: 1440 as const, height: 900 as const },
    }
  },
} satisfies Pick<SpaApi, 'mintDesktopSession'>
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
queryClient.mount()

let observer = new QueryObserver(
  queryClient,
  desktopSessionQueryOptions(api, 'acme', 'https://app.duet.test'),
)
let unsubscribe = observer.subscribe(() => {})
await waitFor(() => calls === 2)
await new Promise(resolve => setTimeout(resolve, 30))
const recoveredInitialAdmission =
  observer.getCurrentResult().data?.entryUrl.includes('grant-2') === true
const retainedExpiredEntry = observer.getCurrentResult().data?.expiresAt === 1

onlineManager.setOnline(false)
onlineManager.setOnline(true)
await waitFor(() => calls === 3)

unsubscribe()
await new Promise(resolve => setTimeout(resolve, 10))
observer = new QueryObserver(
  queryClient,
  desktopSessionQueryOptions(api, 'acme', 'https://app.duet.test'),
)
unsubscribe = observer.subscribe(() => {})
await waitFor(() => calls === 4)

unsubscribe()
queryClient.unmount()
queryClient.clear()

let refusalCalls = 0
const refusalClient = new QueryClient()
refusalClient.mount()
const refusalObserver = new QueryObserver(
  refusalClient,
  desktopSessionQueryOptions(
    {
      mintDesktopSession: async () => {
        refusalCalls += 1
        throw new DuetApiError(403, 'insufficient_scope')
      },
    },
    'acme',
    'https://app.duet.test',
  ),
)
const unsubscribeRefusal = refusalObserver.subscribe(() => {})
await waitFor(() => refusalObserver.getCurrentResult().isError)

unsubscribeRefusal()
refusalClient.unmount()
refusalClient.clear()

let unauthorizedCalls = 0
const unauthorizedClient = new QueryClient()
unauthorizedClient.mount()
const unauthorizedObserver = new QueryObserver(
  unauthorizedClient,
  desktopSessionQueryOptions(
    {
      mintDesktopSession: async () => {
        unauthorizedCalls += 1
        throw new DuetApiError(401, 'unauthorized')
      },
    },
    'acme',
    'https://app.duet.test',
  ),
)
const unsubscribeUnauthorized = unauthorizedObserver.subscribe(() => {})
await waitFor(() => unauthorizedObserver.getCurrentResult().isError)

console.log(
  JSON.stringify({
    calls,
    recoveredInitialAdmission,
    retainedExpiredEntry,
    refusalCalls,
    unauthorizedCalls,
  }),
)
unsubscribeUnauthorized()
unauthorizedClient.unmount()
unauthorizedClient.clear()
delete (globalThis as { window?: EventTarget }).window

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}
