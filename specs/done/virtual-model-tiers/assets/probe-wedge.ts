// Wedge repro + gateway-log capture (VMT handoff 2026-07-31): fresh e2e VMs
// wedge sessions at [session_created, user_prompt] with no turn_started.
// Run: bunx dotenvx run -f ../../.env.staging -- bun src/probe-wedge.ts
/* eslint-disable no-console */

const apiUrl = must('DUET_API_URL')
const loginSecret = must('DUET_PROGRAMMATIC_LOGIN_SECRET')

function must(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} required`)
  return value.replace(/\/+$/, '')
}

async function json<T>(url: string, init: RequestInit, expect: number, label: string): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.text()
  if (response.status !== expect)
    throw new Error(`${label}: ${response.status} ${body.slice(0, 300)}`)
  return JSON.parse(body) as T
}

const runId = `wedge-${Date.now().toString(36)}`
const login = await json<{ token: string; workspaceSlug: string; userId: string }>(
  `${apiUrl}/v1/admin/login-as`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${loginSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `duet-so+${runId}@agentmail.to`,
      create: true,
      ephemeral: true,
      name: `Wedge ${runId}`,
    }),
  },
  200,
  'login',
)
const bearerHeaders = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' }
const slug = login.workspaceSlug
console.log(`workspace ${slug}`)

// Post immediately — the wedge conditions. No client abort below the server hold.
const createStarted = Date.now()
const create = await fetch(`${apiUrl}/v1/ws/${slug}/agent/sessions/default/messages`, {
  method: 'POST',
  headers: bearerHeaders,
  body: JSON.stringify({ prompt: 'Say hello and stop.' }),
  signal: AbortSignal.timeout(600_000),
}).catch(error => ({ error: String(error) }) as const)
if ('error' in create) {
  console.log(
    `create fetch died after ${Math.round((Date.now() - createStarted) / 1000)}s: ${create.error}`,
  )
} else {
  console.log(
    `create HTTP ${create.status} after ${Math.round((Date.now() - createStarted) / 1000)}s`,
  )
}

const resolved = await json<{ id: string }>(
  `${apiUrl}/v1/ws/${slug}/agent/sessions/default`,
  { headers: bearerHeaders },
  200,
  'resolve default',
)
const sessionId = resolved.id
console.log(`session ${sessionId}`)

// Watch for turn_started for 4 minutes; then declare wedged and capture logs.
const watchDeadline = Date.now() + 4 * 60_000
let wedged = true
for (;;) {
  const history = await json<{ events: Array<{ seq: number; event: { type: string } }> }>(
    `${apiUrl}/v1/ws/${slug}/agent/sessions/${sessionId}/history?cursor=0&limit=50`,
    { headers: bearerHeaders },
    200,
    'history',
  )
  const types = history.events.map(row => row.event.type)
  if (types.includes('turn_started')) {
    console.log(`NOT WEDGED: ${types.join(',')}`)
    wedged = false
    break
  }
  if (Date.now() > watchDeadline) {
    console.log(`WEDGED at: ${types.join(',')}`)
    break
  }
  await Bun.sleep(10_000)
}

if (wedged) {
  // whoami may not carry ids; use the admin search instead.
  const admin = await json<{ token: string }>(
    `${apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${loginSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${runId}-user@example.invalid`,
        create: true,
        ephemeral: true,
        name: `Wedge log reader ${runId}`,
        ttlSeconds: 900,
      }),
    },
    200,
    'admin login',
  )
  const adminBearer = { authorization: `Bearer ${admin.token}` }
  const found = await json<{ workspaces: Array<{ id: string; slug: string }> }>(
    `${apiUrl}/v1/internal-admin/search?q=${encodeURIComponent(slug)}`,
    { headers: adminBearer },
    200,
    'admin search',
  )
  const workspaceId = found.workspaces.find(w => w.slug === slug)?.id
  console.log(`workspaceId ${workspaceId}`)
  if (workspaceId !== undefined) {
    const logs = await fetch(
      `${apiUrl}/v1/internal-admin/workspaces/${workspaceId}/logs?source=gateway`,
      {
        headers: adminBearer,
      },
    )
    const text = await logs.text()
    console.log(`==== GATEWAY LOG (${logs.status}) bytes=${text.length} ====`)
    console.log(text.slice(-4000))
    const detail = await fetch(`${apiUrl}/v1/internal-admin/workspaces/${workspaceId}`, {
      headers: adminBearer,
    })
    console.log(`==== WORKSPACE DETAIL (${detail.status}) ====`)
    console.log((await detail.text()).slice(0, 2000))
  }
  console.log('WEDGED WORKSPACE KEPT for ssh inspection — delete manually when done:')
  console.log(`  slug=${slug}`)
} else {
  await fetch(`${apiUrl}/v1/ws/${slug}`, { method: 'DELETE', headers: bearerHeaders }).catch(
    () => undefined,
  )
}
console.log('probe done')
