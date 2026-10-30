import type { SpaApi } from '../context'

const browserWindow = new EventTarget()
;(globalThis as { window?: EventTarget }).window = browserWindow

const [{ focusManager, onlineManager, QueryClient, QueryObserver }, { duetQueryOptions }] =
  await Promise.all([import('@tanstack/react-query'), import('./query-options')])
let calls = 0
const responses = [
  { status: 'pending' as const },
  {
    status: 'awaiting_code' as const,
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://provider.example.test/device',
    expiresAt: 10_000,
  },
  {
    status: 'connected' as const,
    connection: {
      provider: 'openai-codex' as const,
      state: 'connected' as const,
      connectedAt: 1,
    },
  },
]
const api = {
  pollConnectedProvider: async () => {
    const response = responses[calls]
    calls += 1
    if (response === undefined) throw new Error('terminal session was fetched again')
    return response
  },
} satisfies Pick<SpaApi, 'pollConnectedProvider'>
const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } })
const observer = new QueryObserver(
  queryClient,
  duetQueryOptions.workspaces.connectedProviders.poll(api, 'acme', 'session-1', 5),
)

focusManager.setFocused(false)
queryClient.mount()
const unsubscribe = observer.subscribe(() => {})
await waitFor(() => calls === 3)

focusManager.setFocused(true)
await new Promise(resolve => setTimeout(resolve, 20))
onlineManager.setOnline(false)
onlineManager.setOnline(true)
await new Promise(resolve => setTimeout(resolve, 20))

const result = observer.getCurrentResult()
console.log(JSON.stringify({ calls, status: result.data?.status, isError: result.isError }))
unsubscribe()
queryClient.unmount()
queryClient.clear()
delete (globalThis as { window?: EventTarget }).window

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}
