import { convexTest } from 'convex-test'
import {
  componentsGeneric,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
} from 'convex/server'
import { v } from 'convex/values'

import retrierSchema from '../../../node_modules/@convex-dev/action-retrier/dist/component/schema.js'
import { appDomainTarget } from '../convex/config'
import schema from '../convex/schema'

const savedFetch = globalThis.fetch

const savedEnv = { ...process.env }
const fixtures: Array<ReturnType<typeof convexTest>> = []
export async function cleanupCustomDomainFixtures() {
  for (const t of fixtures.splice(0)) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async ctx => {
      await ctx.runMutation(
        componentsGeneric().actionRetrier!.fixture!.cancelPending! as FunctionReference<'mutation'>,
        {},
      )
    })
    await t.run(async ctx => {
      for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
        if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
    })
    await t.finishInProgressScheduledFunctions()
  }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  globalThis.fetch = savedFetch
}
export async function createCustomDomainFixture(options: { transactionLimits?: boolean } = {}) {
  process.env.DUET_API_INTERNAL_KEY = 'domain-key'
  process.env.DUET_VERCEL_DOMAINS_TOKEN = 'provider-token'
  process.env.DUET_VERCEL_TEAM_ID = 'team-fixture'
  process.env.DUET_VERCEL_EDGE_PROJECT_ID = 'project-fixture'
  process.env.DUET_EDGE_HOST = 'edge-staging.duet.so'
  const modules = {
    '../convex/_generated/api.ts': async () => ({}),
    '../convex/domains/customDomains/model.ts': () =>
      import('../convex/domains/customDomains/model'),
    '../convex/domains/customDomains/internal.ts': () =>
      import('../convex/domains/customDomains/internal'),
    '../convex/domains/customDomains/work.ts': () => import('../convex/domains/customDomains/work'),
    '../convex/domains/customDomains/actions.ts': () =>
      import('../convex/domains/customDomains/actions'),
    '../convex/domains/apps/model.ts': () => import('../convex/domains/apps/model'),
    '../convex/domains/workspaceBackups/deletion.ts': () =>
      import('../convex/domains/workspaceBackups/deletion'),
    '../convex/domains/workspaces/vmTeardown.ts': () =>
      import('../convex/domains/workspaces/vmTeardown'),
    '../convex/domains/workspaces/vmTeardownModel.ts': () =>
      import('../convex/domains/workspaces/vmTeardownModel'),
    '../convex/domains/workspaces/vmTeardownSchedule.ts': () =>
      import('../convex/domains/workspaces/vmTeardownSchedule'),
  }
  const t = convexTest({ schema, modules, transactionLimits: options.transactionLimits })
  t.registerComponent('actionRetrier', retrierSchema, {
    './_generated/api.js': () =>
      import('../../../node_modules/@convex-dev/action-retrier/dist/component/_generated/api.js'),
    './public.js': () =>
      import('../../../node_modules/@convex-dev/action-retrier/dist/component/public.js'),
    './fixture.ts': async () => {
      return {
        cancelPending: mutationGeneric({
          args: {},
          handler: async ctx => {
            for (const scheduled of await ctx.db.system.query('_scheduled_functions').collect())
              if (scheduled.state.kind === 'pending') await ctx.scheduler.cancel(scheduled._id)
          },
        }),
        seedExpiredRuns: mutationGeneric({
          args: { count: v.number(), payloadBytes: v.number() },
          handler: async (ctx, args) => {
            const payload = 'x'.repeat(args.payloadBytes)
            for (let index = 0; index < args.count; index += 1) {
              await ctx.db.insert('runs', {
                functionHandle: 'test:action',
                functionArgs: {},
                options: {
                  initialBackoffMs: 1,
                  base: 2,
                  maxFailures: 0,
                  logLevel: 'ERROR',
                },
                state: {
                  type: 'completed',
                  completedAt: 0,
                  result: { type: 'success', returnValue: payload },
                },
                numFailures: 0,
              })
            }
          },
        }),
        hasRuns: queryGeneric({
          args: {},
          handler: async ctx => (await ctx.db.query('runs').first()) !== null,
        }),
      }
    },
    './run.js': () =>
      import('../../../node_modules/@convex-dev/action-retrier/dist/component/run.js'),
  })
  const target = appDomainTarget()
  const assignments = new Map<
    string,
    {
      name: string
      apexName: string
      projectId: string
      gitBranch: string | null
      verified: boolean
    }
  >()
  const requests: Array<{ method: string; path: string }> = []
  const provider = { ownershipVerified: true, misconfigured: false, errorStatus: 0 }
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname !== 'api.vercel.com') return Response.json({ ok: true })
      const method = init?.method ?? 'GET'
      requests.push({ method, path: url.pathname })
      if (provider.errorStatus) return Response.json({}, { status: provider.errorStatus })
      if (url.pathname.endsWith('/config'))
        return Response.json({
          misconfigured: provider.misconfigured,
          conflicts: [],
          recommendedIPv4: [{ rank: 1, value: ['76.76.21.21'] }],
        })
      const host = url.pathname.split('/domains/')[1]?.replace('/verify', '')
      if (method === 'POST' && host === undefined) {
        const { name } = JSON.parse(String(init?.body)) as { name: string }
        const row = {
          name,
          apexName: 'example.com',
          projectId: target.projectId,
          gitBranch: target.gitBranch,
          verified: provider.ownershipVerified,
        }
        assignments.set(name, row)
        return Response.json(row)
      }
      if (method === 'DELETE') {
        assignments.delete(host!)
        return Response.json({})
      }
      const row = assignments.get(host!)
      return row === undefined
        ? Response.json({}, { status: 404 })
        : Response.json({
            ...row,
            verified: provider.ownershipVerified,
            verification: provider.ownershipVerified
              ? []
              : [{ type: 'TXT', domain: host!, value: 'ownership-proof' }],
          })
    },
    { preconnect: savedFetch.preconnect },
  )
  fixtures.push(t)
  const ids = await t.run(async ctx => {
    const actorId = await ctx.db.insert('users', {
      email: 'domain-owner@example.test',
      createdAt: 1,
      updatedAt: 1,
      memberDirectoryRevision: 0,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'domains',
      name: 'Domains',
      status: 'active',
      servicingStatus: 'active',
      createdByUserId: actorId,
      billingUserId: actorId,
      createdAt: 1,
    })
    await ctx.db.insert('workspaceMembers', { workspaceId, userId: actorId, role: 'owner' })
    for (const slug of ['one', 'two']) {
      const anchorId = await ctx.db.insert('anchors', {
        workspaceId,
        path: `apps/${slug}`,
        markerNonce: slug,
        kind: 'app',
        state: 'active',
        settings: {},
        createdAt: 1,
        updatedAt: 1,
      })
      await ctx.db.insert('apps', {
        workspaceId,
        anchorId,
        slug,
        command: 'bun run start',
        apiScopes: [],
        port: slug === 'one' ? 4001 : 4002,
        visibility: 'folder',
        runtimeStatus: 'reconciled',
        createdByUserId: actorId,
        createdAt: 1,
        updatedAt: 1,
      })
    }
    return { actorId, workspaceId }
  })
  return {
    t,
    assignments,
    requests,
    provider,
    args: {
      internalKey: 'domain-key',
      workspaceId: ids.workspaceId,
      identity: {
        principal: { kind: 'human' as const, userId: ids.actorId },
        actorId: ids.actorId,
      },
    },
  }
}
export async function settleDomainWork(t: ReturnType<typeof convexTest>) {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await t.finishInProgressScheduledFunctions()
  }
}
