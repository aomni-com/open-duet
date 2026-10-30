import { expect, test } from 'bun:test'
import { join, relative } from 'node:path'

import { convexTest } from 'convex-test'

import schema from '../convex/schema'

const BACKEND_ROOT = join(import.meta.dir, '..')

test('all deployable timeline events pass through the byte-bounded writer', async () => {
  const insertOwners: string[] = []
  for await (const path of new Bun.Glob('convex/**/*.ts').scan({
    cwd: BACKEND_ROOT,
    absolute: true,
  })) {
    if (
      path.includes('/convex/_generated/') ||
      path.includes('/convex/testing/') ||
      path.endsWith('.test.ts')
    ) {
      continue
    }
    const source = await Bun.file(path).text()
    if (/\.insert\(['"]agentSessionEvents['"]/.test(source)) {
      insertOwners.push(relative(BACKEND_ROOT, path))
    }
  }
  expect(insertOwners).toEqual(['convex/domains/agentSessions/agentSessionsShared.ts'])
})

test('all deployable session creation stays in the initial-delivery writer', async () => {
  const insertOwners: string[] = []
  for await (const path of new Bun.Glob('convex/**/*.ts').scan({
    cwd: BACKEND_ROOT,
    absolute: true,
  })) {
    if (path.includes('/convex/_generated/') || path.endsWith('.test.ts')) continue
    const source = await Bun.file(path).text()
    if (/\.insert\(['"]agentSessions['"]/.test(source)) {
      insertOwners.push(relative(BACKEND_ROOT, path))
    }
  }
  expect(insertOwners).toEqual(['convex/domains/agentSessions/creation.ts'])
})

test('every production session transition that changes discovery dimensions uses its owner', async () => {
  const projectionPatchOwners: string[] = []
  const forbiddenRawPatches: string[] = []
  const rawSessionPatchCounts = new Map<string, number>()
  for await (const path of new Bun.Glob('convex/**/*.ts').scan({
    cwd: BACKEND_ROOT,
    absolute: true,
  })) {
    if (
      path.includes('/convex/_generated/') ||
      path.includes('/convex/testing/') ||
      path.endsWith('.test.ts')
    ) {
      continue
    }
    const source = await Bun.file(path).text()
    const relativePath = relative(BACKEND_ROOT, path)
    if (source.includes('patchSessionAndReconcileDiscovery(ctx,')) {
      projectionPatchOwners.push(relativePath)
    }
    for (const call of functionCalls(source, 'ctx.db.patch')) {
      const targetsSession = /\(\s*(?:session\._id|args\.sessionId|sessionId)\s*,/.test(call)
      const changesDiscovery =
        /\b(?:updatedAt|archiveState|visible|bucket|agentId|audienceKind)\s*:/.test(call)
      const onboardingArchiveAllowlist =
        relativePath === 'convex/domains/agents/model.ts' &&
        /archiveState\s*:\s*['"]archived['"]/.test(call)
      if (
        targetsSession &&
        !onboardingArchiveAllowlist &&
        relativePath !== 'convex/domains/agentSessions/discovery.ts'
      ) {
        rawSessionPatchCounts.set(relativePath, (rawSessionPatchCounts.get(relativePath) ?? 0) + 1)
      }
      if (targetsSession && changesDiscovery && !onboardingArchiveAllowlist) {
        forbiddenRawPatches.push(
          `${relativePath}:${source.slice(0, source.indexOf(call)).split('\n').length}`,
        )
      }
    }
  }
  expect(projectionPatchOwners.sort()).toEqual(
    [
      'convex/domains/agentSessions/cwd.ts',
      'convex/domains/agentSessions/deletion.ts',
      'convex/domains/agentSessions/delivery.ts',
      'convex/domains/agentSessions/events.ts',
      'convex/domains/agentSessions/lifecycle.ts',
      'convex/domains/agentSessions/membershipRemoval.ts',
      'convex/domains/agentSessions/titles.ts',
      'convex/migrations.ts',
    ].sort(),
  )
  expect(Object.fromEntries([...rawSessionPatchCounts].sort())).toEqual({
    'convex/domains/agentSessions/agentSessionsShared.ts': 1,
    'convex/domains/agentSessions/creation.ts': 4,
    'convex/domains/agentSessions/delivery.ts': 1,
    'convex/domains/workspaces/tierSweep.ts': 1,
  })
  expect(forbiddenRawPatches).toEqual([])
})

test('grouped activity reads only the bounded discovery projection', async () => {
  const source = await Bun.file(
    join(BACKEND_ROOT, 'convex/domains/agentSessions/activity.ts'),
  ).text()
  expect(source).toContain('listSessionActivityDiscovery')
  expect(source).toContain('getSessionActivityDiscovery')
  expect(source).not.toContain('listSessionDiscovery')
  expect(source).not.toContain('sessionSummary(')
  expect(source).not.toContain('chatSummary(')
  expect(source).not.toMatch(/ctx\.db\.get\(chatId\)/)
})

function functionCalls(source: string, callee: string): string[] {
  const calls: string[] = []
  let start = source.indexOf(callee)
  while (start !== -1) {
    const open = source.indexOf('(', start + callee.length)
    let depth = 0
    let cursor = open
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') depth += 1
      if (source[cursor] === ')') {
        depth -= 1
        if (depth === 0) {
          calls.push(source.slice(start, cursor + 1))
          break
        }
      }
    }
    start = source.indexOf(callee, cursor + 1)
  }
  return calls
}

test('the discovery table exposes every accepted indexed lane family', async () => {
  const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
  await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {
      email: 'discovery@example.test',
      memberDirectoryRevision: 0,
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'discovery-schema',
      name: 'Discovery Schema',
      status: 'active',
      billingUserId: userId,
      createdAt: 1,
    })
    const sessionId = await ctx.db.insert('agentSessions', {
      workspaceId,
      userId,
      audienceKind: 'workspace',
      turnStatus: 'running',
      bucket: 'running',
      prompt: 'Prompt',
      title: 'Title',
      titleOrigin: 'excerpt',
      titleStatus: 'complete',
      searchText: 'title\nprompt',
      archiveState: 'active',
      visible: true,
      lastEventSeq: 0,
      lastRunnerInputSeq: 0,
      runnerInputPending: false,
      lastDeliveredInputSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await ctx.db.insert('agentSessionDiscovery', {
      workspaceId,
      laneKey: 'workspace',
      sessionId,
      archiveState: 'active',
      bucket: 'running',
      orderKey: '0000000000000001:session',
      title: 'Title',
      updatedAt: 1,
      lastEventSeq: 0,
    })

    const reads = await Promise.all([
      ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_lane_archive_order', q =>
          q
            .eq('workspaceId', workspaceId)
            .eq('laneKey', 'workspace')
            .eq('onboarding', undefined)
            .eq('archiveState', 'active'),
        )
        .collect(),
      ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_lane_archive_bucket_order', q =>
          q
            .eq('workspaceId', workspaceId)
            .eq('laneKey', 'workspace')
            .eq('onboarding', undefined)
            .eq('archiveState', 'active')
            .eq('bucket', 'running'),
        )
        .collect(),
      ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_lane_agent_archive_order', q =>
          q
            .eq('workspaceId', workspaceId)
            .eq('laneKey', 'workspace')
            .eq('onboarding', undefined)
            .eq('agentId', undefined)
            .eq('archiveState', 'active'),
        )
        .collect(),
      ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_lane_agent_archive_bucket_order', q =>
          q
            .eq('workspaceId', workspaceId)
            .eq('laneKey', 'workspace')
            .eq('onboarding', undefined)
            .eq('agentId', undefined)
            .eq('archiveState', 'active')
            .eq('bucket', 'running'),
        )
        .collect(),
      ctx.db
        .query('agentSessionDiscovery')
        .withIndex('by_session_lane', q => q.eq('sessionId', sessionId).eq('laneKey', 'workspace'))
        .collect(),
    ])
    expect(reads.map(rows => rows.map(row => row.sessionId))).toEqual(
      Array.from({ length: 5 }, () => [sessionId]),
    )
  })
})
