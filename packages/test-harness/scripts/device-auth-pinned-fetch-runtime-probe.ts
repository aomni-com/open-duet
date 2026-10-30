import { resolve4, resolve6 } from 'node:dns/promises'
import { request } from 'node:https'
import type { LookupFunction } from 'node:net'
import type { TLSSocket } from 'node:tls'

const target = new URL(process.argv[2] ?? 'https://ctl-staging.duet.so/')
if (target.protocol !== 'https:') throw new Error('probe target must use HTTPS')

const [ipv4Addresses, ipv6Addresses] = await Promise.all([
  resolveOrEmpty(() => resolve4(target.hostname)),
  resolveOrEmpty(() => resolve6(target.hostname)),
])
const addresses = [
  ...ipv4Addresses.map(address => ({ address, family: 4 as const })),
  ...ipv6Addresses.map(address => ({ address, family: 6 as const })),
]
const selected = addresses[0]
if (!selected) throw new Error(`no A or AAAA records resolved for ${target.hostname}`)

let lookupCalls = 0
const lookup: LookupFunction = (_hostname, options, callback) => {
  lookupCalls += 1
  if (typeof options === 'object' && options.all) {
    ;(
      callback as (
        error: NodeJS.ErrnoException | null,
        addresses: Array<{ address: string; family: number }>,
      ) => void
    )(null, [selected])
    return
  }
  ;(callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(
    null,
    selected.address,
    selected.family,
  )
}

const result = await new Promise<{
  status: number
  remoteAddress: string | undefined
  servername: string | false | null
  hostHeader: string
  bytes: number
}>((resolve, reject) => {
  const probe = request(
    target,
    {
      lookup,
      servername: target.hostname,
      headers: { host: target.host },
      timeout: 5_000,
    },
    response => {
      // Node 24 detaches response.socket before 'end'; capture at headers time.
      const remoteAddress = response.socket?.remoteAddress
      const servername = (response.socket as TLSSocket | null)?.servername
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > 64 * 1024) probe.destroy(new Error('probe response exceeded the 64 KiB bound'))
      })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          remoteAddress,
          servername,
          hostHeader: target.host,
          bytes,
        })
      })
    },
  )
  probe.once('timeout', () => probe.destroy(new Error('probe exceeded the 5 s bound')))
  probe.once('error', reject)
  probe.end()
})

if (lookupCalls !== 1)
  throw new Error(`expected the pinned lookup exactly once; observed ${lookupCalls}`)
if (normalizeAddress(result.remoteAddress) !== normalizeAddress(selected.address))
  throw new Error(
    `socket escaped DNS pin: selected ${selected.address}, connected ${String(result.remoteAddress)}`,
  )
if (result.servername !== target.hostname)
  throw new Error(`TLS SNI mismatch: expected ${target.hostname}, observed ${result.servername}`)

const isDeployedRuntime = process.env.VERCEL === '1'
console.log(
  JSON.stringify(
    {
      verdict: isDeployedRuntime ? 'pass' : 'local-only-not-kill-gate-evidence',
      runtime: {
        node: process.version,
        vercel: process.env.VERCEL === '1',
        region: process.env.VERCEL_REGION ?? null,
      },
      target: target.toString(),
      resolvedAddresses: addresses,
      selectedAddress: selected,
      lookupCalls,
      connection: result,
    },
    null,
    2,
  ),
)
if (!isDeployedRuntime) process.exitCode = 2

function normalizeAddress(address: string | undefined): string {
  return (address ?? '').toLowerCase().replace(/^::ffff:/, '')
}

async function resolveOrEmpty(resolveAddresses: () => Promise<string[]>): Promise<string[]> {
  try {
    return await resolveAddresses()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENODATA' || code === 'ENOTFOUND') return []
    throw error
  }
}
