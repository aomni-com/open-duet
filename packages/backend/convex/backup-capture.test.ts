import { afterEach, expect, test } from 'bun:test'

import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'

import { AddMcpServerRequestSchema } from '@repo/contract'

import { BackupCapturePageSchema, type BackupCapturePage } from '../../contract/src/backups/capture'
import type { Id } from './_generated/dataModel'
import { MAX_CAPTURE_RECORD_BYTES } from './domains/workspaceBackups/capture'
import schema from './schema'

const previousKey = process.env.DUET_API_INTERNAL_KEY
afterEach(() => {
  if (previousKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = previousKey
})
function fixture() {
  process.env.DUET_API_INTERNAL_KEY = 'backup-test'
  return convexTest(schema, {
    './_generated/api.ts': async () => ({}),
    './testing/workspaceBackups.ts': () => import('./testing/workspaceBackups'),
    './domains/workspaceBackups/capture.ts': () => import('./domains/workspaceBackups/capture'),
  })
}
const page = makeFunctionReference<'query'>('domains/workspaceBackups/capture:page')
async function seed(t: ReturnType<typeof fixture>) {
  return t.run(async ctx => {
    const user = await ctx.db.insert('users', {
      email: 'not-exported@example.com',
      createdAt: 1,
      updatedAt: 1,
      paidCreditBalanceMicroUsd: 99,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
    })
    const workspaceId = await ctx.db.insert('workspaces', {
      slug: 'source',
      name: 'Source',
      status: 'active',
      billingUserId: user,
      duetName: 'Helper',
      purpose: 'Build things',
      defaultModelId: 'model',
      onboardedAt: 2,
      vmTokenHash: 'never-export',
      createdAt: 1,
    })
    const foreign = await ctx.db.insert('workspaces', {
      slug: 'foreign',
      name: 'Foreign',
      status: 'active',
      billingUserId: user,
      createdAt: 1,
    })
    return { user, workspaceId, foreign }
  })
}

test('settings export is a portable allowlist, not a workspace or member dump', async () => {
  const t = fixture()
  const { workspaceId } = await seed(t)
  expect(
    await t.query(page, {
      internalKey: 'backup-test',
      workspaceId,
      collection: 'settings',
      cutoff: Date.now(),
      cursor: null,
    }),
  ).toEqual({
    records: [
      {
        kind: 'settings',
        name: 'Source',
        slug: 'source',
        assistantName: 'Helper',
        purpose: 'Build things',
        defaultModelId: 'model',
        onboardedAt: 2,
      },
    ],
    warnings: [],
    nextCursor: null,
  })
})

async function session(
  t: ReturnType<typeof fixture>,
  workspaceId: Id<'workspaces'>,
  user: Id<'users'>,
  extra = {},
) {
  return t.run(ctx =>
    ctx.db.insert('agentSessions', {
      workspaceId,
      userId: user,
      audienceKind: 'workspace',
      turnStatus: 'complete',
      bucket: 'done',
      prompt: 'Original prompt',
      title: 'History',
      titleOrigin: 'manual',
      titleStatus: 'complete',
      searchText: 'history',
      archiveState: 'active',
      visible: true,
      lastEventSeq: 7,
      lastRunnerInputSeq: 0,
      runnerInputPending: false,
      lastDeliveredInputSeq: 0,
      createdAt: 1,
      updatedAt: 2,
      ...extra,
    }),
  )
}

test('canonical pagination includes hidden archived children, excludes later and foreign rows, and warns on deletion', async () => {
  const t = fixture()
  const { workspaceId, foreign, user } = await seed(t)
  const root = await session(t, workspaceId, user)
  const archived = await session(t, workspaceId, user, {
    archiveState: 'archived',
    visible: false,
    onboarding: true,
    createdBySessionId: root,
  })
  const children = [
    await session(t, workspaceId, user),
    await session(t, workspaceId, user),
    await session(t, workspaceId, user),
  ]
  const deleting = await session(t, workspaceId, user, { archiveState: 'deleting' })
  await session(t, foreign, user)
  const cutoff = (await t.run(ctx => ctx.db.get(deleting)))!._creationTime
  await session(t, workspaceId, user)
  const records: BackupCapturePage['records'] = []
  const warnings: BackupCapturePage['warnings'] = []
  let cursor: string | null = null
  do {
    const result: BackupCapturePage = await t.query(page, {
      internalKey: 'backup-test',
      workspaceId,
      collection: 'sessions',
      cutoff,
      cursor,
    })
    records.push(...result.records)
    warnings.push(...result.warnings)
    cursor = result.nextCursor
  } while (cursor)
  expect(records.map(r => (r.kind === 'session' ? r.key : undefined))).toEqual([
    root,
    archived,
    ...children,
  ])
  expect(records[1]).toMatchObject({
    parentKey: root,
    archived: true,
    visible: false,
    onboarding: true,
    eventCeiling: 7,
  })
  expect(records[0]).not.toHaveProperty('userId')
  expect(records[0]).not.toHaveProperty('audienceKind')
  expect(warnings).toEqual([
    { code: 'disappeared', recordKey: deleting, detail: 'Session is being deleted' },
  ])
})

test('full events stop at a captured ceiling and image sources are bound to their session and workspace', async () => {
  const t = fixture()
  const { workspaceId, foreign, user } = await seed(t)
  const id = await session(t, workspaceId, user)
  const other = await session(t, foreign, user)
  const image = await t.run(async ctx => {
    const storageId = await ctx.storage.store(new Blob(['image-bytes'], { type: 'image/png' }))
    await ctx.db.insert('agentSessionImages', {
      workspaceId,
      sessionId: id,
      storageId,
      mimeType: 'image/png',
      bytes: 11,
    })
    for (const seq of [1, 3, 7, 9])
      await ctx.db.insert('agentSessionEvents', {
        workspaceId,
        sessionId: id,
        seq,
        createdAt: seq,
        event: {
          type: seq === 3 ? 'task_started' : 'message',
          text: `event-${seq}`,
          images: seq === 1 ? [{ storageId, mimeType: 'image/png', bytes: 11 }] : [],
        },
        submittingActorId: user,
        clientRequestId: 'never-export',
      })
    return storageId
  })
  const args = {
    internalKey: 'backup-test',
    workspaceId,
    cutoff: Date.now() + 10000,
    cursor: null,
    sessionId: id,
  }
  const result = await t.query(page, { ...args, collection: 'events', ceiling: 7 })
  expect(BackupCapturePageSchema.parse(result)).toEqual(result)
  expect(result.records.map((r: { seq: number }) => r.seq)).toEqual([1, 3, 7])
  expect(result.records[1].event).toMatchObject({ type: 'task_started', text: 'event-3' })
  expect(result.records[0]).not.toHaveProperty('submittingActorId')
  expect(result.records[0]).not.toHaveProperty('clientRequestId')
  const images = await t.query(page, { ...args, collection: 'images' })
  expect(images.records[0]).toMatchObject({
    kind: 'image',
    storageId: image,
    sessionKey: id,
    mimeType: 'image/png',
    bytes: 11,
  })
  expect(images.records[0].sourceUrl).toBe(await t.run(ctx => ctx.storage.getUrl(image)))
  expect(await t.run(async ctx => (await ctx.storage.get(image))!.text())).toBe('image-bytes')
  await expect(
    t.query(page, { ...args, collection: 'events', ceiling: 7, sessionId: other }),
  ).rejects.toThrow('Session unavailable')
  await expect(t.query(page, { ...args, collection: 'events' })).rejects.toThrow('ceiling')
  await t.run(ctx => ctx.storage.delete(image))
  expect((await t.query(page, { ...args, collection: 'images' })).warnings).toMatchObject([
    { code: 'missing_image', recordKey: image },
  ])
})

test('integration export preserves policy states and static tokens while OAuth remains reconnect-only', async () => {
  const t = fixture()
  const { workspaceId, user } = await seed(t)
  await t.run(async ctx => {
    for (const [name, authKind] of [
      ['absent', 'none'],
      ['empty', 'static'],
      ['restricted', 'oauth'],
    ] as const) {
      const serverId = await ctx.db.insert('mcpServers', {
        workspaceId,
        name,
        label: name,
        url: `https://${name}.example/mcp`,
        authKind,
        state: 'ready',
        createdAt: 1,
        updatedAt: 1,
        createdByUserId: user,
      })
      if (name !== 'absent')
        await ctx.db.insert('mcpServerAgentPolicies', {
          workspaceId,
          serverId,
          allowedAgentIds: name === 'empty' ? [] : ['root'],
          createdAt: 1,
          updatedAt: 1,
        })
      if (authKind !== 'none')
        await ctx.db.insert('mcpServerCredentials', {
          workspaceId,
          serverId,
          kind: authKind,
          accessToken: authKind === 'static' ? 'portable-token' : 'never-oauth',
          refreshToken: 'never-refresh',
          tokenType: 'Bearer',
          generation: 7,
          createdAt: 1,
          updatedAt: 1,
        })
    }
    await ctx.db.insert('integrationAgentPolicies', {
      workspaceId,
      toolkitSlug: 'github',
      allowedAgentIds: [],
      createdAt: 1,
      updatedAt: 1,
    })
    await ctx.db.insert('connectedProviders', {
      workspaceId,
      provider: 'openai-codex',
      state: 'connected',
      connectedByUserId: user,
      connectedAt: 1,
    })
  })
  const args = { internalKey: 'backup-test', workspaceId, cutoff: Date.now() + 10000, cursor: null }
  const result = await t.query(page, { ...args, collection: 'mcpServers' })
  expect(BackupCapturePageSchema.parse(result)).toEqual(result)
  expect(result.records[0]).not.toHaveProperty('allowedAgentIds')
  expect(result.records[1]).toMatchObject({
    allowedAgentIds: [],
    token: 'portable-token',
    authKind: 'static',
  })
  expect(
    AddMcpServerRequestSchema.parse({
      name: result.records[1].name,
      url: result.records[1].url,
      auth: { kind: result.records[1].authKind, token: result.records[1].token },
    }).auth,
  ).toEqual({ kind: 'static', token: 'portable-token' })
  expect(result.records[2]).toMatchObject({ allowedAgentIds: ['root'], reconnectRequired: true })
  expect(JSON.stringify(result)).not.toContain('never-')
  expect(JSON.stringify(result)).not.toContain('generation')
  expect((await t.query(page, { ...args, collection: 'toolkitPolicies' })).records).toEqual([
    { kind: 'toolkitPolicy', toolkitSlug: 'github', allowedAgentIds: [] },
  ])
  expect((await t.query(page, { ...args, collection: 'providers' })).records).toEqual([
    { kind: 'provider', provider: 'openai-codex', reconnectRequired: true },
  ])
})

test('agents and apps resolve logical paths and report dangling anchors without runtime authority', async () => {
  const t = fixture()
  const { workspaceId, foreign, user } = await seed(t)
  await t.run(async ctx => {
    const anchorId = await ctx.db.insert('anchors', {
      workspaceId,
      path: 'agents/helper',
      kind: 'agent',
      state: 'active',
      markerNonce: 'never-marker',
      settings: {},
      createdAt: 1,
      updatedAt: 1,
    })
    const broken = await ctx.db.insert('anchors', {
      workspaceId: foreign,
      path: 'foreign/path',
      kind: 'app',
      state: 'active',
      markerNonce: 'never-marker',
      settings: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await ctx.db.insert('agents', {
      workspaceId,
      anchorId,
      slug: 'helper',
      name: 'Helper',
      disabledAt: 4,
      createdByUserId: user,
      createdAt: 1,
      updatedAt: 2,
    })
    await ctx.db.insert('apps', {
      workspaceId,
      anchorId: broken,
      slug: 'app',
      command: 'bun run start',
      apiScopes: ['files:read'],
      visibility: 'folder',
      runtimeStatus: 'reconciled',
      contentGeneration: 'never-generation',
      createdByUserId: user,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  const args = { internalKey: 'backup-test', workspaceId, cutoff: Date.now() + 10000, cursor: null }
  const agents = await t.query(page, { ...args, collection: 'agents' })
  expect(agents.records[0]).toMatchObject({
    kind: 'agent',
    path: 'agents/helper',
    slug: 'helper',
    name: 'Helper',
    disabled: true,
  })
  expect(agents.records[0]).not.toHaveProperty('createdByUserId')
  const apps = await t.query(page, { ...args, collection: 'apps' })
  expect(apps.records[0]).toMatchObject({
    kind: 'app',
    path: null,
    command: 'bun run start',
    apiScopes: ['files:read'],
    visibility: 'folder',
    disabled: false,
  })
  expect(apps.warnings).toMatchObject([{ code: 'dangling_metadata' }])
  expect(JSON.stringify(apps)).not.toContain('foreign/path')
  expect(JSON.stringify(apps)).not.toContain('never-generation')
})

test('a record exceeding the serialized byte budget yields explicit evidence and still advances', async () => {
  const t = fixture()
  const { workspaceId, user } = await seed(t)
  const id = await session(t, workspaceId, user)
  await t.run(async ctx => {
    await ctx.db.insert('agentSessionEvents', {
      workspaceId,
      sessionId: id,
      seq: 1,
      createdAt: 1,
      event: { text: '\u0000'.repeat(Math.ceil(MAX_CAPTURE_RECORD_BYTES / 6)) },
    })
    await ctx.db.insert('agentSessionEvents', {
      workspaceId,
      sessionId: id,
      seq: 2,
      createdAt: 2,
      event: { text: 'retained' },
    })
  })
  const result = await t.query(page, {
    internalKey: 'backup-test',
    workspaceId,
    cutoff: Date.now() + 10000,
    cursor: null,
    collection: 'events',
    sessionId: id,
    ceiling: 2,
  })
  expect(result.records).toEqual([
    { kind: 'event', sessionKey: id, seq: 2, createdAt: 2, event: { text: 'retained' } },
  ])
  expect(result.warnings).toMatchObject([{ code: 'incomplete_collection', recordKey: `${id}:1` }])
  expect(result.nextCursor).toBeNull()
})

test('a session removed after enumeration finishes its collection with a source warning', async () => {
  const t = fixture()
  const { workspaceId, user } = await seed(t)
  const id = await session(t, workspaceId, user)
  await t.run(ctx => ctx.db.delete(id))
  expect(
    await t.query(page, {
      internalKey: 'backup-test',
      workspaceId,
      cutoff: Date.now() + 10000,
      cursor: null,
      collection: 'events',
      sessionId: id,
      ceiling: 7,
    }),
  ).toEqual({
    records: [],
    nextCursor: null,
    warnings: [{ code: 'disappeared', recordKey: id, detail: 'Session unavailable' }],
  })
})

test('missing session parent and agent retain local references with explicit warnings', async () => {
  const t = fixture()
  const { workspaceId, user } = await seed(t)
  const parent = await session(t, workspaceId, user)
  const agent = await t.run(async ctx => {
    const anchorId = await ctx.db.insert('anchors', {
      workspaceId,
      path: 'agent',
      kind: 'agent',
      state: 'active',
      markerNonce: 'marker',
      settings: {},
      createdAt: 1,
      updatedAt: 1,
    })
    return ctx.db.insert('agents', {
      workspaceId,
      anchorId,
      slug: 'agent',
      createdByUserId: user,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  const child = await session(t, workspaceId, user, { createdBySessionId: parent, agentId: agent })
  await t.run(async ctx => {
    await ctx.db.delete(parent)
    await ctx.db.delete(agent)
  })
  const result = await t.query(page, {
    internalKey: 'backup-test',
    workspaceId,
    cutoff: Date.now() + 10000,
    cursor: null,
    collection: 'sessions',
  })
  expect(result.records[0]).toMatchObject({ key: child, parentKey: parent, agentKey: agent })
  expect(result.warnings).toEqual([
    { code: 'dangling_metadata', recordKey: child, detail: 'Session agent is unavailable' },
    { code: 'dangling_metadata', recordKey: child, detail: 'Session parent is unavailable' },
  ])
})

test('live backup fixture exports exact inert parent and child history without discovery or runner work', async () => {
  const t = fixture()
  const { workspaceId, user } = await seed(t)
  const seeded = await t.run(async ctx => {
    await ctx.db.patch(workspaceId, { ephemeral: true })
    const anchorId = await ctx.db.insert('anchors', {
      workspaceId,
      path: 'agents/fixture',
      kind: 'agent',
      state: 'active',
      settings: {},
      markerNonce: 'fixture',
      createdAt: 1,
      updatedAt: 1,
    })
    const agentId = await ctx.db.insert('agents', {
      workspaceId,
      anchorId,
      slug: 'fixture',
      name: 'Fixture',
      createdByUserId: user,
      createdAt: 1,
      updatedAt: 1,
    })
    const imageStorageId = await ctx.storage.store(new Blob(['image'], { type: 'image/png' }))
    return { agentId, imageStorageId }
  })
  const result = await t.mutation(
    makeFunctionReference<'mutation'>('testing/workspaceBackups:seedMetadata'),
    { internalKey: 'backup-test', workspaceId, ...seeded, imageBytes: 5, marker: 'fixture-marker' },
  )
  await t.run(async ctx => {
    for (const id of [result.parentId, result.childId]) {
      expect(await ctx.db.get(id)).toMatchObject({
        archiveState: 'archived',
        visible: false,
        bucket: 'done',
        turnStatus: 'complete',
        runnerInputPending: false,
        lastRunnerInputSeq: 0,
        lastDeliveredInputSeq: 0,
      })
    }
    expect(await ctx.db.query('agentSessionDiscovery').collect()).toEqual([])
    expect(await ctx.db.system.query('_scheduled_functions').collect()).toEqual([])
  })
  const base = { internalKey: 'backup-test', workspaceId, cutoff: Date.now() + 1000 }
  const sessions = await t.query(page, { ...base, collection: 'sessions', cursor: null })
  expect(sessions.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: result.parentId,
        prompt: 'fixture-marker',
        archived: true,
        visible: false,
        eventCeiling: result.eventCount,
      }),
      expect.objectContaining({ key: result.childId, parentKey: result.parentId, eventCeiling: 1 }),
    ]),
  )
  const events: Array<{ seq: number; event: unknown }> = []
  let cursor: string | null = null
  do {
    const batch: BackupCapturePage = await t.query(page, {
      ...base,
      collection: 'events',
      sessionId: result.parentId,
      ceiling: result.eventCount,
      cursor,
    })
    events.push(...batch.records.filter(record => record.kind === 'event'))
    cursor = batch.nextCursor
  } while (cursor !== null)
  expect(events.map(event => event.seq)).toEqual(
    Array.from({ length: result.eventCount }, (_, i) => i + 1),
  )
  expect(events[0]).toMatchObject({
    event: {
      type: 'prompt_submitted',
      prompt: 'fixture-marker',
      images: [{ storageId: seeded.imageStorageId, mimeType: 'image/png', bytes: 5 }],
    },
  })
  expect(events[result.eventCount - 1]).toMatchObject({
    event: { type: 'task_output', chunk: `fixture-marker:${result.eventCount}\n` },
  })
  const childEvents = await t.query(page, {
    ...base,
    collection: 'events',
    sessionId: result.childId,
    ceiling: 1,
    cursor: null,
  })
  expect(childEvents.records).toEqual([
    {
      kind: 'event',
      sessionKey: result.childId,
      seq: 1,
      createdAt: expect.any(Number),
      event: { type: 'agent_message', message: 'Child fixture-marker' },
    },
  ])
  const images = await t.query(page, {
    ...base,
    collection: 'images',
    sessionId: result.parentId,
    cursor: null,
  })
  expect(images.records).toEqual([
    expect.objectContaining({
      kind: 'image',
      sessionKey: result.parentId,
      storageId: seeded.imageStorageId,
      bytes: 5,
      sourceUrl: await t.run(ctx => ctx.storage.getUrl(seeded.imageStorageId)),
    }),
  ])
})
