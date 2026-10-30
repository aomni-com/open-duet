// Durable staging diagnostic: provision a workspace, create a session, and
// surface the full dispatch trail (create latency, SSE frames, session
// detail) so silent-session incidents are observable without a full e2e.
// Leaves the workspace alive for VM-level inspection — retire it afterwards.
// Run: bunx dotenvx run -f .env.staging -- bun packages/test-harness/scripts/probe-session-dispatch.ts
import { readLiveEnv } from '../src/staging-live-env.ts'

const env = readLiveEnv(process.env)
const runId = `probe-dispatch-${process.pid}`
const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
})

async function json<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const started = Date.now()
  const response = await fetch(url, init)
  const text = await response.text()
  console.log(`${label}: HTTP ${response.status} in ${Date.now() - started}ms`)
  if (!response.ok) {
    console.log(`  body: ${text.slice(0, 400)}`)
    throw new Error(`${label} failed`)
  }
  return JSON.parse(text) as T
}

const login = await json<{ token: string; workspaceSlug: string }>(
  `${env.apiUrl}/v1/admin/login-as`,
  {
    method: 'POST',
    headers: bearer(env.loginSecret),
    body: JSON.stringify({ email: `duet-so+${runId}@agentmail.to`, create: true, name: runId }),
  },
  'login-as',
)

// Wait for the workspace VM to be active before the session probe.
for (let i = 0; i < 60; i++) {
  const whoami = await json<{ workspaces: { slug: string; status: string }[] }>(
    `${env.apiUrl}/v1/whoami`,
    { headers: bearer(login.token) },
    `whoami[${i}]`,
  )
  const ws = whoami.workspaces.find(w => w.slug === login.workspaceSlug)
  console.log(`  workspace ${ws?.slug}: ${ws?.status}`)
  if (ws?.status === 'active') break
  await new Promise(r => setTimeout(r, 10_000))
}

const created = await json<{ session: { sessionId: string }; dispatched: boolean }>(
  `${env.apiUrl}/v1/ws/${login.workspaceSlug}/agent/sessions`,
  {
    method: 'POST',
    headers: bearer(login.token),
    body: JSON.stringify({ prompt: 'Reply with exactly: PROBE-OK' }),
  },
  'session-create',
)
console.log(`dispatched=${created.dispatched} sessionId=${created.session.sessionId}`)

// Poll the session record and print status transitions + read SSE briefly.
const eventsUrl = `${env.apiUrl}/v1/ws/${login.workspaceSlug}/agent/sessions/${created.session.sessionId}/events`
const controller = new AbortController()
setTimeout(() => controller.abort(), 120_000)
const sse = fetch(eventsUrl, {
  headers: { authorization: `Bearer ${login.token}` },
  signal: controller.signal,
})
  .then(async response => {
    console.log(`sse: HTTP ${response.status}`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value)
      console.log(`SSE> ${chunk.slice(0, 220).replaceAll('\n', ' | ')}`)
    }
  })
  .catch(error => console.log(`sse ended: ${String(error).slice(0, 120)}`))

for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 10_000))
  const detail = await json<Record<string, unknown>>(
    `${env.apiUrl}/v1/ws/${login.workspaceSlug}/agent/sessions/${created.session.sessionId}`,
    { headers: bearer(login.token) },
    `session-detail[${i}]`,
  ).catch(() => undefined)
  if (detail) console.log(`  detail: ${JSON.stringify(detail).slice(0, 300)}`)
}
await sse
console.log('probe done (workspace left alive for inspection):', login.workspaceSlug)
