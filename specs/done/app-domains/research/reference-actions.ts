import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalize, runControlledResponses, type ProviderFixture } from './reference-probe'

type Row = Record<string, unknown> & { _id: string }
type Handler = { handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> }
type Modules = { actions: Record<string, Handler>; storage: Record<string, Handler> }
type ActionFixture = {
  id: string
  action: string
  args: Record<string, unknown>
  initialRows: Row[]
  providerCaseIds: string[]
  expected: { requests: unknown[]; outcome: unknown; rows: Row[] }
}

// Only framework/runtime boundaries are replaced. The frozen action, storage,
// normalization and provider implementation bodies are bundled without editing.
async function loadLegacyActions(): Promise<Modules> {
  const snapshots = new URL('../assets/reference/', import.meta.url)
  const references = [
    'getDomainByName',
    'getById',
    'resolveByDomain',
    'listForOrganization',
    'listForApp',
    'listByStatus',
    'createDomain',
    'updateDomain',
    'deleteDomain',
  ]
  const modules: Record<string, string> = {
    entry:
      "export * as actions from 'snapshot:actions.ts.txt'; export * as storage from 'snapshot:internal.ts.txt'",
    'convex/values': 'export const v = new Proxy({}, {get: () => () => ({})})',
    '@repo/backend/convex/_generated/server':
      'export const action = x => x; export const internalAction = action; export const internalMutation = action; export const internalQuery = action',
    '@repo/backend/convex/model/auth':
      "export async function ensureAuthAndUserAction() { return {user: {_id: 'user-1'}} }",
    '@repo/backend/convex/_generated/api': `export const internal = ${JSON.stringify({ domains: { customDomains: { internal: Object.fromEntries(references.map(name => [name, name])) }, organizations: { internal: { isUserInOrganization: 'membership' } }, sandboxes: { internal: { getSandboxByGatewayToken: 'sandbox' } } } })}`,
  }
  const build = await Bun.build({
    entrypoints: ['entry'],
    target: 'bun',
    write: false,
    plugins: [
      {
        name: 'frozen-convex-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path }) => {
            if (path === '../../services/vercel')
              return { path: 'vercel.ts.txt', namespace: 'snapshot' }
            if (path.startsWith('snapshot:'))
              return { path: path.slice('snapshot:'.length), namespace: 'snapshot' }
            if (path in modules) return { path, namespace: 'boundary' }
            throw new Error(`Unexpected legacy import: ${path}`)
          })
          builder.onLoad({ filter: /.*/, namespace: 'boundary' }, ({ path }) => ({
            contents: modules[path]!,
            loader: 'ts',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'snapshot' }, async ({ path }) => ({
            contents: await readFile(new URL(path, snapshots), 'utf8'),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  assert.equal(build.success, true, JSON.stringify(build.logs))
  const directory = await mkdtemp(join(tmpdir(), 'duet-domain-actions-'))
  try {
    const modulePath = join(directory, 'actions.mjs')
    await writeFile(modulePath, await build.outputs[0]!.text())
    return await import(pathToFileURL(modulePath).href)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function actionContext(modules: Modules, initialRows: Row[]) {
  const rows = new Map(initialRows.map(row => [row._id, structuredClone(row)]))
  const calls: unknown[] = []
  const db = {
    get: async (id: string) => structuredClone(rows.get(id) ?? null),
    insert: async (_table: string, row: Record<string, unknown>) => {
      const id = `domain-${rows.size + 1}`
      rows.set(id, { ...row, _id: id })
      return id
    },
    patch: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id)
      assert.ok(row, `Missing fixture row ${id}`)
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete row[key]
        else row[key] = value
      }
    },
    delete: async (id: string) => {
      rows.delete(id)
    },
    query: (_table: string) => {
      const filters: Array<[string, unknown]> = []
      const matching = () =>
        [...rows.values()]
          .filter(row => filters.every(([key, value]) => row[key] === value))
          .map(row => structuredClone(row))
      const query = {
        withIndex: (_index: string, callback: (q: unknown) => unknown) => {
          const selector = {
            eq: (key: string, value: unknown) => {
              filters.push([key, value])
              return selector
            },
          }
          callback(selector)
          return query
        },
        unique: async () => {
          assert.ok(matching().length <= 1, 'Fixture uniqueness')
          return matching()[0] ?? null
        },
        take: async (limit: number) => matching().slice(0, limit),
        collect: async () => matching(),
      }
      return query
    },
  }
  const ctx = {
    db,
    runQuery: async (reference: string, args: Record<string, unknown>) => {
      const result =
        reference === 'membership'
          ? true
          : reference === 'sandbox'
            ? { organizationId: 'org-1' }
            : await modules.storage[reference]!.handler(ctx, args)
      calls.push({
        kind: 'query',
        reference,
        args: normalize(args),
        result: normalize(structuredClone(result)),
      })
      return result
    },
    runMutation: async (reference: string, args: Record<string, unknown>) => {
      const result = await modules.storage[reference]!.handler(ctx, args)
      calls.push({ kind: 'mutation', reference, args: normalize(args), result: normalize(result) })
      return result
    },
  }
  return { ctx, calls, rows }
}

export async function runActionFixtures(providerCases: ProviderFixture[]) {
  const fixtures: ActionFixture[] = JSON.parse(
    await readFile(new URL('action-fixtures.json', import.meta.url), 'utf8'),
  )
  const modules = await loadLegacyActions()
  const originalNow = Date.now
  const originalError = console.error
  Date.now = () => 1_800_000_000_000
  try {
    const results = []
    for (const fixture of fixtures) {
      const harness = actionContext(modules, fixture.initialRows)
      const logs: unknown[] = []
      console.error = (...args) =>
        logs.push(
          args.map(arg =>
            arg instanceof Error ? { name: arg.name, message: arg.message } : normalize(arg),
          ),
        )
      const responses = fixture.providerCaseIds.flatMap(id => {
        const providerCase = providerCases.find(entry => entry.id === id)
        assert.ok(providerCase, `Missing provider input ${id}`)
        return providerCase.responses
      })
      const result = await runControlledResponses(fixture.id, responses, () =>
        modules.actions[fixture.action]!.handler(harness.ctx, fixture.args),
      )
      const rows = [...harness.rows.values()].map(row => JSON.parse(JSON.stringify(row)))
      assert.deepEqual(
        { requests: result.requests, outcome: result.outcome, rows },
        fixture.expected,
        `Action contract: ${fixture.id}`,
      )
      results.push({ ...result, calls: harness.calls, rows, logs })
    }
    return results
  } finally {
    Date.now = originalNow
    console.error = originalError
  }
}
