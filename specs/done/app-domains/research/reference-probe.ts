import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const research = new URL('.', import.meta.url)
const snapshots = new URL('../assets/reference/', research)

export type ProviderFixture = {
  id: string
  operation: 'add' | 'read' | 'verify' | 'remove'
  domain: string
  responses: Array<{ status: number; body: unknown }>
  expected: { requests: unknown[]; outcome: unknown }
}

type Provider = Record<ProviderFixture['operation'], (domain: string) => Promise<unknown>>

export function normalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]))
  }
  return value
}

async function outcome(operation: () => Promise<unknown>) {
  try {
    return { kind: 'return', value: normalize(await operation()) }
  } catch (error) {
    return {
      kind: 'throw',
      error: {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export async function loadProviderFixtures(): Promise<{
  configuration: Record<string, string>
  cases: ProviderFixture[]
}> {
  return JSON.parse(await readFile(new URL('provider-fixtures.json', research), 'utf8'))
}

async function verifiedSources() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', snapshots), 'utf8'))
  for (const source of manifest.sources) {
    const bytes = await readFile(new URL(source.snapshot, snapshots))
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      source.sha256,
      `Frozen source changed: ${source.snapshot}`,
    )
  }
  for (const artifact of manifest.reproduction?.artifacts ?? []) {
    const bytes = await readFile(new URL(`../${artifact.path}`, research))
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      artifact.sha256,
      `Frozen probe artifact changed: ${artifact.path}`,
    )
  }
  assert.equal(Bun.version, manifest.localBunVersion, 'Run with the frozen Bun version')
  return manifest.referenceRevision as string
}

async function loadLegacyProvider(): Promise<Provider> {
  const source = await readFile(new URL('vercel.ts.txt', snapshots), 'utf8')
  const compiled = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(source)
  const directory = await mkdtemp(join(tmpdir(), 'duet-domain-reference-'))
  try {
    const modulePath = join(directory, 'provider.mjs')
    await writeFile(modulePath, compiled)
    const legacy = await import(pathToFileURL(modulePath).href)
    return {
      add: legacy.addDomainToProject,
      read: legacy.getDomainStatus,
      verify: legacy.verifyDomain,
      remove: legacy.removeDomainFromProject,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function runControlledResponses(
  id: string,
  responses: ProviderFixture['responses'],
  operation: () => Promise<unknown>,
) {
  const requests: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push({
      method: request.method,
      pathname: url.pathname,
      query: [...url.searchParams.entries()],
      headers: Object.fromEntries(
        [...request.headers].map(([key, value]) => [
          key,
          key === 'authorization' ? '<redacted>' : value,
        ]),
      ),
      body: request.body ? await request.text() : null,
    })
    assert.equal(
      url.origin,
      'https://api.vercel.com',
      'Fixture transport refuses a different origin',
    )
    const response = responses[requests.length - 1]
    assert.ok(response, `Unscripted HTTP request in ${id}`)
    return new Response(
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
      { status: response.status },
    )
  }) as typeof fetch
  try {
    const result = {
      id,
      requests,
      outcome: await outcome(operation),
    }
    assert.equal(requests.length, responses.length, `Unused scripted response in ${id}`)
    return result
  } finally {
    globalThis.fetch = originalFetch
  }
}

export async function runProviderFixture(provider: Provider, fixture: ProviderFixture) {
  return runControlledResponses(fixture.id, fixture.responses, () =>
    provider[fixture.operation](fixture.domain),
  )
}

export async function runReferenceProbe({ only }: { only?: string } = {}) {
  const referenceRevision = await verifiedSources()
  const fixtures = await loadProviderFixtures()
  const previousEnvironment = Object.fromEntries(
    Object.keys(fixtures.configuration).map(key => [key, process.env[key]]),
  )
  Object.assign(process.env, fixtures.configuration)
  try {
    const provider = await loadLegacyProvider()
    const results = []
    for (const fixture of fixtures.cases.filter(entry => !only || entry.id === only)) {
      const result = await runProviderFixture(provider, fixture)
      assert.deepEqual(
        { requests: result.requests, outcome: result.outcome },
        fixture.expected,
        `Reference contract: ${fixture.id}`,
      )
      results.push(result)
    }
    assert.ok(results.length, `No fixture matched ${only}`)
    return {
      referenceRevision,
      provider: results,
      actions: only
        ? []
        : await (await import('./reference-actions')).runActionFixtures(fixtures.cases),
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await runReferenceProbe(), null, 2)}\n`)
}
