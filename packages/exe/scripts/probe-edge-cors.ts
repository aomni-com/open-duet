import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { ConvexHttpClient } from 'convex/browser'
/**
 * train-uploads slice 01 probe: does the exe.dev edge in front of VM ports
 * 3000-9999 forward an UNAUTHENTICATED browser CORS preflight (OPTIONS with no
 * x-exedev-authorization header) to the gateway, and does it pass custom
 * request headers through? Browsers send preflights with no credentials, so
 * if the edge rejects them, direct browser→VM uploads cannot work without an
 * ingress change — that verdict gates the rest of the direct-upload ladder.
 *
 * Run: bunx dotenvx run -f .env.staging -- bun packages/exe/scripts/probe-edge-cors.ts <workspace-slug>
 */
import { makeFunctionReference } from 'convex/server'

import { convexUrlsFromDeployment } from '@repo/contract'
import { ExeClient } from '@repo/exe'

import { PROBE_TRANSCRIPTS_DIR, probeTranscriptUrl } from './probe-artifacts.ts'

const slug = process.argv[2] ?? 'test'
const convexDeployment = required('CONVEX_DEPLOYMENT')
const internalKey = required('DUET_API_INTERNAL_KEY')
const appUrl = required('DUET_APP_URL')
const exeToken = required('EXE_TOKEN')

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`missing env ${name}`)
  return value
}

interface ProbeRecord {
  name: string
  request: { method: string; url: string; headers: Record<string, string> }
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

const transcript: ProbeRecord[] = []

async function probe(
  name: string,
  method: string,
  url: string,
  headers: Record<string, string>,
): Promise<ProbeRecord> {
  const response = await fetch(url, { method, headers, redirect: 'manual' })
  const body = (await response.text()).slice(0, 500)
  const record: ProbeRecord = {
    name,
    request: { method, url, headers: redact(headers) },
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }
  transcript.push(record)
  console.log(`\n=== ${name}\n${method} ${url}\n→ ${response.status} ${response.statusText}`)
  for (const [k, v] of Object.entries(record.headers)) {
    if (k.startsWith('access-control') || k === 'server' || k === 'www-authenticate')
      console.log(`   ${k}: ${v}`)
  }
  console.log(`   body: ${body.slice(0, 200).replaceAll('\n', ' ')}`)
  return record
}

function redact(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) =>
      k.toLowerCase().includes('authorization') ? [k, '<redacted>'] : [k, v],
    ),
  )
}

const convex = new ConvexHttpClient(convexUrlsFromDeployment(convexDeployment).cloudUrl)
const gateway = (await convex.query(
  makeFunctionReference<'query'>('domains/workspaces/provisioning:gatewayConnectionBySlug'),
  { internalKey, slug },
)) as { httpsUrl?: string; vmName?: string; vmToken?: string } | null
if (gateway?.httpsUrl === undefined || gateway.vmName === undefined) {
  throw new Error(`workspace '${slug}' has no attached VM (gateway=${JSON.stringify(gateway)})`)
}

const base = new URL(gateway.httpsUrl)
base.port = '3000'
const origin = new URL(appUrl).origin
console.log(`probing ${base.origin} (vm=${gateway.vmName}) with browser origin ${origin}`)

const exe = new ExeClient({ token: exeToken })
const edgeToken = await exe.generateVmApiKey(gateway.vmName, 'slice01-cors-probe', '1h')

// 1. Control: healthz with the edge credential — proves the path works at all.
await probe('healthz WITH edge token', 'GET', `${base.origin}/healthz`, {
  'x-exedev-authorization': `Bearer ${edgeToken}`,
})

// 2. healthz with no credentials at all — does the edge gate every request?
await probe('healthz NO credentials', 'GET', `${base.origin}/healthz`, {})

// 3. The browser preflight exactly as Chrome would send it: no credentials.
await probe(
  'preflight OPTIONS NO credentials (the real browser shape)',
  'OPTIONS',
  `${base.origin}/v1/train/uploads/probe.bin`,
  {
    origin,
    'access-control-request-method': 'PUT',
    'access-control-request-headers': 'authorization,x-exedev-authorization,content-type',
  },
)

// 4. Same preflight WITH the edge token (not a real browser shape — isolates
//    whether edge auth is the only blocker).
await probe(
  'preflight OPTIONS WITH edge token',
  'OPTIONS',
  `${base.origin}/v1/train/uploads/probe.bin`,
  {
    origin,
    'access-control-request-method': 'PUT',
    'access-control-request-headers': 'authorization,content-type',
    'x-exedev-authorization': `Bearer ${edgeToken}`,
  },
)

// 5. Authenticated-at-the-edge GET straight to a gateway route: proves the
//    edge passes arbitrary methods/paths through to the gateway (expect the
//    gateway's own 401, not an edge error).
await probe(
  'gateway route WITH edge token, no VM bearer',
  'GET',
  `${base.origin}/v1/train/uploads`,
  {
    origin,
    'x-exedev-authorization': `Bearer ${edgeToken}`,
  },
)

const transcriptUrl = probeTranscriptUrl(
  `edge-cors-probe-${new Date().toISOString().slice(0, 10)}.json`,
)
await mkdir(fileURLToPath(PROBE_TRANSCRIPTS_DIR), { recursive: true })
await Bun.write(
  transcriptUrl,
  JSON.stringify({ probedAt: new Date().toISOString(), vm: gateway.vmName, transcript }, null, 2),
)
console.log(`\ntranscript → ${fileURLToPath(transcriptUrl)}`)
