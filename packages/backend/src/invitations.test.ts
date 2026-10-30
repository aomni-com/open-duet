import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConvexHttpClient } from 'convex/browser'

import { hashApiKey } from '@repo/contract'
import {
  act,
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { INVITE_LIFETIME_MS } from '../convex/domains/invitations/model'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUTH_CODE = TEST_AUTH_CODE
const INTERNAL_KEY = 'invitations-internal-key'

let convex: ConvexDevFixture
let fixtureProject: string
let postHog: ReturnType<typeof Bun.serve>
const capturedSignupEvents: Array<{ event: string; properties: Record<string, unknown> }> = []

describe('workspace invitations and authenticated bootstrap', () => {
  beforeAll(async () => {
    postHog = Bun.serve({
      port: 0,
      async fetch(request) {
        const event = (await request.json()) as {
          event: string
          properties: Record<string, unknown>
        }
        if (event.event === 'user.signed_up') capturedSignupEvents.push(event)
        return Response.json({ status: 'ok' })
      },
    })
    // Only backend source is private; installed dependencies stay shared.
    fixtureProject = mkdtempSync(join(tmpdir(), 'duet-invitations-source-'))
    cpSync(join(BACKEND_DIR, 'convex'), join(fixtureProject, 'convex'), { recursive: true })
    for (const name of ['package.json', 'convex.json'])
      copyFileSync(join(BACKEND_DIR, name), join(fixtureProject, name))
    symlinkSync(
      join(BACKEND_DIR, '../../node_modules'),
      join(fixtureProject, 'node_modules'),
      'dir',
    )
    const configPath = join(fixtureProject, 'convex/domains/campaigns/config.ts')
    const config = readFileSync(configPath, 'utf8')
    const start = config.indexOf('export const campaigns =')
    const end = config.indexOf('export type CampaignSlug', start)
    writeFileSync(
      configPath,
      config.slice(0, start) +
        `export const campaigns = defineCampaigns({
      'fixture-signup': { enabled: true, attributionWindowMs: 20_000 },
      'fixture-other': { enabled: true, attributionWindowMs: 20_000 },
    })

` +
        config.slice(end),
    )
    convex = await convexDev(fixtureProject, {
      env: {
        ...generateAuthKeys(),
        DUET_TEST_AUTH_CODE: AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'http://localhost:3000',
        POSTHOG_API_KEY: 'invitations-posthog-key',
        POSTHOG_HOST: postHog.url.href,
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    try {
      await convex?.stop()
    } finally {
      postHog?.stop(true)
      if (fixtureProject) rmSync(fixtureProject, { recursive: true, force: true })
    }
  })

  // Deleting a workspace leaves the owner's membership row behind — nothing
  // cascades it and no cron collects it. Bootstrap reads memberships to decide
  // whether this user already has a home, so a reader that does not exclude
  // tombstones hands a returning user a dead workspace and never creates the
  // live one they came back for.
  test('a returning user whose only workspace was deleted is given a new one', async () => {
    const signedIn = await signInWithoutBootstrap(uniqueEmail('rebootstrap'), 'Returning User')
    const first = await bootstrap(signedIn.client)

    await mutate(convex, 'testing/workspaces:deleteWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: first.workspaceId,
    })
    expect(await rawWorkspace(first.workspaceId)).toMatchObject({ status: 'deleted' })

    const second = await bootstrap(signedIn.client)

    expect(second.workspaceId).not.toBe(first.workspaceId)
    expect(await rawWorkspace(second.workspaceId)).not.toMatchObject({ status: 'deleted' })
    // And the user can see exactly the live one, not the tombstone beside it.
    expect(await listMine(signedIn.client)).toEqual([
      expect.objectContaining({
        role: 'owner',
        workspace: expect.objectContaining({ _id: second.workspaceId }),
      }),
    ])
  })

  test('auth creates the user only and bootstrap creates one workspace idempotently', async () => {
    const signedIn = await signInWithoutBootstrap(uniqueEmail('bootstrap'), 'Bootstrap User')
    expect(await listMine(signedIn.client)).toEqual([])

    const first = await bootstrap(signedIn.client)
    const firstWorkspace = await rawWorkspace(first.workspaceId)
    const afterFirst = await rawUser(signedIn.user.email)
    const second = await bootstrap(signedIn.client)
    const afterSecond = await rawUser(signedIn.user.email)
    expect(second).toEqual(first)
    expect(afterFirst.signupProcessedAt).toEqual(expect.any(Number))
    expect(afterSecond.signupProcessedAt).toBe(afterFirst.signupProcessedAt)
    expect(firstWorkspace).not.toHaveProperty('onboardedAt')
    expect(await rawWorkspace(first.workspaceId)).not.toHaveProperty('onboardedAt')
    expect(await listMine(signedIn.client)).toEqual([
      expect.objectContaining({
        role: 'owner',
        workspace: expect.objectContaining({ _id: first.workspaceId }),
      }),
    ])
  })

  test('a new incomplete workspace does not schedule a VM at signup', async () => {
    const signedIn = await signInWithoutBootstrap(uniqueEmail('lazy-vm-bootstrap'), 'Lazy VM')

    const { workspaceId } = await bootstrap(signedIn.client)
    const workspace = await rawWorkspace(workspaceId)

    expect(workspace).not.toHaveProperty('vmAttachRunId')
    expect(workspace).not.toHaveProperty('vmName')
    expect(workspace).not.toHaveProperty('onboardedAt')
  })

  test('a signup with no name and no workspace name derives from the email localpart', async () => {
    // The live defect, pinned as it stands: Convex Auth forwards neither the
    // `name` param nor anything else into the profile, so `users.name` is
    // unset and the derivation falls through to the address. Every browser
    // signup takes this branch, and an absent `workspaceName` must leave it
    // byte-identical.
    const email = uniqueEmail('derived-workspace')
    const signedIn = await signInWithoutBootstrap(email, 'Dropped By Convex Auth')

    const { workspaceId } = await bootstrap(signedIn.client)

    expect(await rawUser(email)).not.toHaveProperty('name')
    expect((await rawWorkspace(workspaceId)).name).toBe(`${email.split('@')[0]}'s Workspace`)
  })

  test('a supplied workspace name is used verbatim and the slug follows it', async () => {
    const signedIn = await signInWithoutBootstrap(uniqueEmail('named-workspace'), 'Casey')

    const { workspaceId } = await bootstrap(signedIn.client, { workspaceName: 'Acme Ops' })
    const workspace = await rawWorkspace(workspaceId)

    expect(workspace.name).toBe('Acme Ops')
    expect(workspace.slug).toBe('acme-ops')
  })

  test('a blank workspace name falls back to the derivation', async () => {
    const email = uniqueEmail('blank-workspace-name')
    const signedIn = await signInWithoutBootstrap(email, 'Blank')

    const { workspaceId } = await bootstrap(signedIn.client, { workspaceName: '   ' })

    expect((await rawWorkspace(workspaceId)).name).toBe(`${email.split('@')[0]}'s Workspace`)
  })

  test('a workspace name applies at birth only, never as a rename', async () => {
    // Bootstrap returns an existing membership without creating anything, so a
    // second signup carrying a different name changes nothing. That is correct
    // — naming is scoped to first signup — and the copy an agent reads has to
    // say so, or it will believe it renamed something.
    const signedIn = await signInWithoutBootstrap(uniqueEmail('rename-attempt'), 'Rename Attempt')

    const first = await bootstrap(signedIn.client, { workspaceName: 'Birth Name' })
    const second = await bootstrap(signedIn.client, { workspaceName: 'Rename Attempt Co' })

    expect(second).toEqual(first)
    expect((await rawWorkspace(first.workspaceId)).name).toBe('Birth Name')
  })

  test('a stored name names the workspace and survives a later nameless sign-in', async () => {
    // `createOrLinkUserForAuth` is the one writer of `users.name`, and the name
    // it stores is what bootstrap derives from when no override is given. The
    // magic-link sign-in afterwards carries no profile fields at all: "absent
    // is not empty" is what keeps it from erasing the name already there.
    const email = uniqueEmail('named-account')

    const minted = (await mutate(convex, 'domains/apiKeys/api:mintImpersonationKey', {
      internalKey: INTERNAL_KEY,
      email,
      ttlSeconds: 600,
      now: Date.now(),
      createIfMissing: true,
      name: 'Casey Jones',
    })) as { workspaceSlug: string }

    expect((await rawUser(email)).name).toBe('Casey Jones')
    expect(minted.workspaceSlug).toBe('casey-jones-s-workspace')

    await signInWithoutBootstrap(email, 'Ignored By Convex Auth')

    expect((await rawUser(email)).name).toBe('Casey Jones')
  })

  test('concurrent bootstrap converges on one workspace and one signup marker', async () => {
    const signedIn = await signInWithoutBootstrap(
      uniqueEmail('concurrent-bootstrap'),
      'Concurrent Bootstrap',
    )
    const concurrentClient = convex.clientWithAuth(signedIn.token)

    const [first, second] = await Promise.all([
      bootstrap(signedIn.client),
      bootstrap(concurrentClient),
    ])
    const user = await rawUser(signedIn.user.email)

    expect(second).toEqual(first)
    expect(user.signupProcessedAt).toEqual(expect.any(Number))
    expect(await listMine(signedIn.client)).toEqual([
      expect.objectContaining({
        role: 'owner',
        workspace: expect.objectContaining({ _id: first.workspaceId }),
      }),
    ])
  })

  test('concurrent acquisition bootstrap with the same token commits one signup event', async () => {
    const signedIn = await signInWithoutBootstrap(
      uniqueEmail('same-token-bootstrap'),
      'Same Token Bootstrap',
    )
    const minted = await mintSignupAttribution('fixture-signup')
    const args = { tokens: { acquisition: minted.attributionId } }
    const firstClient = signedIn.client
    const secondClient = convex.clientWithAuth(signedIn.token)

    const [first, second] = await Promise.all([
      act(firstClient, 'domains/signupAbuse/actions:signUp', args),
      act(secondClient, 'domains/signupAbuse/actions:signUp', args),
    ])
    const user = await rawUser(signedIn.user.email)
    const events = await signupEvents(signedIn.user._id)

    expect(second).toEqual(first)
    expect(user.acquisitionAttributionId).toBe(minted.attributionId)
    expect(events).toEqual([
      expect.objectContaining({
        event: 'user.signed_up',
        properties: expect.objectContaining({
          distinct_id: signedIn.user._id,
          $insert_id: `signup:${signedIn.user._id}`,
          attribution_id: user.acquisitionAttributionId,
        }),
      }),
    ])
  })

  test('concurrent competing handoffs commit one acquisition and one signup event', async () => {
    const signedIn = await signInWithoutBootstrap(
      uniqueEmail('competing-token-bootstrap'),
      'Competing Token Bootstrap',
    )
    const [firstAttribution, secondAttribution] = await Promise.all([
      mintSignupAttribution('fixture-signup'),
      mintSignupAttribution('fixture-other'),
    ])
    const firstClient = signedIn.client
    const secondClient = convex.clientWithAuth(signedIn.token)

    await Promise.all([
      act(firstClient, 'domains/signupAbuse/actions:signUp', {
        tokens: { acquisition: firstAttribution.attributionId },
      }),
      act(secondClient, 'domains/signupAbuse/actions:signUp', {
        tokens: { acquisition: secondAttribution.attributionId },
      }),
    ])

    const user = await rawUser(signedIn.user.email)
    const candidateIds = [firstAttribution.attributionId, secondAttribution.attributionId]
    const rows = (await query(convex, 'testing/campaigns:listAttributionsForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<Record<string, unknown>>
    const claimed = rows.filter(
      row => candidateIds.includes(String(row._id)) && row.acquiredByUserId === signedIn.user._id,
    )
    const events = await signupEvents(signedIn.user._id)

    const acquisitionAttributionId = user.acquisitionAttributionId
    if (acquisitionAttributionId === undefined) throw new Error('Acquisition was not bound')
    expect(candidateIds).toContain(acquisitionAttributionId)
    expect(claimed.map(row => row._id)).toEqual([acquisitionAttributionId])
    expect(events).toEqual([
      expect.objectContaining({
        event: 'user.signed_up',
        properties: expect.objectContaining({
          distinct_id: signedIn.user._id,
          $insert_id: `signup:${signedIn.user._id}`,
          attribution_id: user.acquisitionAttributionId,
        }),
      }),
    ])
  })

  test('concurrent two-user handoff replay transactionally claims one acquisition owner', async () => {
    const firstEmail = uniqueEmail('handoff-first')
    const secondEmail = uniqueEmail('handoff-second')
    const first = await signInWithMagicLink<UserRow>(convex, firstEmail, 'Handoff First')
    const second = await signInWithMagicLink<UserRow>(convex, secondEmail, 'Handoff Second')
    const minted = (await mutate(convex, 'domains/campaigns/api:mintAttribution', {
      internalKey: INTERNAL_KEY,
      campaignSlug: 'fixture-signup',
      action: 'signup',
      signals: {},
      now: Date.now(),
    })) as {
      ok: true
      attributionId: string
    }

    await Promise.all([
      act(first.client, 'domains/signupAbuse/actions:signUp', {
        tokens: { acquisition: minted.attributionId },
      }),
      act(second.client, 'domains/signupAbuse/actions:signUp', {
        tokens: { acquisition: minted.attributionId },
      }),
    ])

    const users = await Promise.all([rawUser(firstEmail), rawUser(secondEmail)])
    const acquired = users.filter(user => user.acquisitionAttributionId === minted.attributionId)
    const rows = (await query(convex, 'testing/campaigns:listAttributionsForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<Record<string, unknown>>
    const attribution = rows.find(row => row._id === minted.attributionId)

    expect(acquired).toHaveLength(1)
    expect(attribution?.acquiredByUserId).toBe(acquired[0]?._id)
  })

  test('a later owned workspace is not onboarding eligible', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('later-workspace'),
      'Later Workspace Owner',
    )
    await mutate(
      owner.client,
      'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest',
      {
        internalKey: INTERNAL_KEY,
      },
    )
    const workspaceId = (await mutate(owner.client, 'testing/workspaces:createWorkspaceForTest', {
      internalKey: INTERNAL_KEY,
      slug: `later-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Later Workspace',
    })) as string

    expect(await rawWorkspace(workspaceId)).toHaveProperty('onboardedAt')
  })

  test('a canonical-email invite gives a brand-new user only the invited workspace and role', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('invite-owner'),
      'Invite Owner',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    expect(await rawWorkspace(workspaceId)).not.toHaveProperty('onboardedAt')
    const inviteeEmail = `invitee-${Date.now()}@gmail.com`
    const invitedAlias = inviteeEmail.replace('invitee-', 'in.vi.tee-').replace('@', '+launch@')
    const token = tokenFor('new-user')
    await createInvite(owner.client, {
      workspaceId,
      email: `  ${invitedAlias.toUpperCase()}  `,
      role: 'viewer',
      token,
    })

    const invitee = await signInWithMagicLink<UserRow>(
      convex,
      inviteeEmail,
      'Invited User',
      AUTH_CODE,
      token,
    )
    expect(await listMine(invitee.client)).toEqual([
      expect.objectContaining({
        role: 'viewer',
        workspace: expect.objectContaining({ _id: workspaceId }),
      }),
    ])
    expect(await rawWorkspace(workspaceId)).not.toHaveProperty('onboardedAt')
    const invites = await rawInvites(workspaceId)
    expect(invites).toEqual([
      expect.objectContaining({
        email: inviteeEmail,
        role: 'viewer',
        consumedByUserId: invitee.user._id,
        consumedAt: expect.any(Number),
      }),
    ])
  })

  test('ordinary signup remains available when the email has a pending invitation', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('pending-owner'), 'Owner')
    const workspace = (await listMine(owner.client))[0]!.workspace
    const email = uniqueEmail('pending-signup')
    const token = tokenFor('pending-signup')
    await createInvite(owner.client, { workspaceId: workspace._id, email, role: 'editor', token })
    const invitee = await signInWithoutBootstrap(email, 'Invitee')

    const personal = await bootstrap(invitee.client)
    expect(personal.invited).toBe(false)
    expect(personal.workspaceId).not.toBe(workspace._id)
    expect(await listMine(invitee.client)).toEqual([
      expect.objectContaining({
        role: 'owner',
        workspace: expect.objectContaining({ _id: personal.workspaceId }),
      }),
    ])
    await bootstrap(invitee.client, { invite: token })
    expect(
      (await listMine(invitee.client)).map(row => [row.workspace._id, row.role]).sort(),
    ).toEqual(
      [
        [personal.workspaceId, 'owner'],
        [workspace._id, 'editor'],
      ].sort(),
    )
  })

  test('unavailable invitation refusals survive the backend transport', async () => {
    const recipient = await signInWithoutBootstrap(uniqueEmail('unavailable-invite'), 'Recipient')
    await expect(
      mutate(convex, 'domains/invitations/mutations:acceptIncomingFromApi', {
        internalKey: INTERNAL_KEY,
        actorId: recipient.user._id,
        inviteId: 'not-an-invitation',
      }),
    ).rejects.toMatchObject({ data: 'Invite could not be accepted' })
  })

  test('accepted invitations can be retried after expiry without changing membership', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('retry-owner'), 'Owner')
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    const email = `staging-e2e-${crypto.randomUUID()}@agentmail.to`
    const recipient = await signInWithoutBootstrap(email, 'Recipient')
    const token = tokenFor('retry-expired')
    const invite = await createInvite(owner.client, { workspaceId, email, role: 'viewer', token })
    const accept = () =>
      mutate(convex, 'domains/invitations/mutations:acceptIncomingFromApi', {
        internalKey: INTERNAL_KEY,
        actorId: recipient.user._id,
        inviteId: invite._id,
      })
    const accepted = await accept()
    const before = await rawInvites(workspaceId)
    await mutate(convex, 'testing/stagingE2e:expireInviteForTest', {
      internalKey: INTERNAL_KEY,
      inviteId: invite._id,
      expectedEmail: email,
      now: Date.now(),
    })
    expect(await accept()).toEqual(accepted)
    expect(await bootstrap(recipient.client, { invite: token })).toMatchObject({
      workspaceId,
      invited: true,
    })
    expect((await listMine(recipient.client)).map(row => [row.workspace._id, row.role])).toEqual([
      [workspaceId, 'viewer'],
    ])
    expect((await rawInvites(workspaceId))[0]?.consumedAt).toBe(before[0]?.consumedAt)
  })

  test('incoming invitations are listed for their recipient without exposing the email token', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('inbox-owner'), 'Inviter')
    const workspace = (await listMine(owner.client))[0]!.workspace
    const email = uniqueEmail('inbox-recipient')
    const recipient = await signInWithoutBootstrap(email, 'Recipient')
    const invite = await createInvite(owner.client, {
      workspaceId: workspace._id,
      email,
      role: 'viewer',
      token: tokenFor('inbox'),
    })
    const list = (actorId: string) =>
      query(convex, 'domains/invitations/queries:incomingFromApi', {
        internalKey: INTERNAL_KEY,
        actorId,
        asOf: Date.now(),
        paginationOpts: { cursor: null, numItems: 10 },
      }) as Promise<{ page: unknown[] }>
    expect((await list(recipient.user._id)).page).toEqual([
      {
        id: invite._id,
        workspace: {
          id: workspace._id,
          slug: workspace.slug,
          name: (await rawWorkspace(workspace._id)).name,
        },
        inviter: {
          ...(owner.user.name === undefined ? {} : { name: owner.user.name }),
          email: owner.user.email,
        },
        role: 'viewer',
        expiresAt: expect.any(Number),
      },
    ])
    expect((await list(owner.user._id)).page).toEqual([])
  })

  test('an existing member accepts another workspace invite without disturbing memberships', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('owner-two'), 'Owner Two')
    const existing = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('existing'),
      'Existing Member',
    )
    const originalWorkspaceId = (await listMine(existing.client))[0]!.workspace._id
    const invitedWorkspaceId = (await listMine(owner.client))[0]!.workspace._id
    const token = tokenFor('existing-user')
    await createInvite(owner.client, {
      workspaceId: invitedWorkspaceId,
      email: existing.user.email,
      role: 'editor',
      token,
    })

    const accepted = await bootstrap(existing.client, { invite: token })
    expect(accepted).toMatchObject({
      workspaceId: invitedWorkspaceId,
      workspaceSlug: (await rawWorkspace(invitedWorkspaceId)).slug,
      invited: true,
    })
    const workspaceRows = await listMine(existing.client)
    expect(workspaceRows.map(row => [row.workspace._id, row.role]).sort()).toEqual(
      [
        [originalWorkspaceId, 'owner'],
        [invitedWorkspaceId, 'editor'],
      ].sort(),
    )
  })

  test('an invitation to a deleted workspace does not block ordinary bootstrap', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('deleted-invite-owner'),
      'Owner',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    const email = uniqueEmail('deleted-invite')
    await createInvite(owner.client, {
      workspaceId,
      email,
      role: 'editor',
      token: tokenFor('deleted-invite'),
    })
    await mutate(convex, 'testing/workspaces:deleteWorkspaceByIdForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })
    const user = await signInWithoutBootstrap(email, 'Returning User')

    const result = await bootstrap(user.client)
    expect(await listMine(user.client)).toEqual([
      expect.objectContaining({
        role: 'owner',
        workspace: expect.objectContaining({ _id: result.workspaceId }),
      }),
    ])
    expect(result.workspaceId).not.toBe(workspaceId)
  })

  test('invite acceptance loses a full-workspace race without consuming the invite', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('capacity-owner'),
      'Capacity Owner',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    const inviteeEmail = uniqueEmail('capacity-invitee')
    const token = tokenFor('capacity')
    const invite = await createInvite(owner.client, {
      workspaceId,
      email: inviteeEmail,
      role: 'viewer',
      token,
    })
    const invitee = await signInWithoutBootstrap(inviteeEmail, 'Capacity Invitee')
    await mutate(convex, 'testing/workspaces:fillWorkspaceMemberCapacityForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })

    await expect(bootstrap(invitee.client, { invite: token })).rejects.toThrow(
      /workspace_member_limit_reached/,
    )
    const storedInvite = (await rawInvites(workspaceId)).find(row => row._id === invite._id)
    expect(storedInvite).toBeDefined()
    expect(storedInvite).not.toHaveProperty('consumedAt')
    expect(storedInvite).not.toHaveProperty('consumedByUserId')
    expect(await listMine(invitee.client)).toEqual([])
  })

  test('an invalid invite fails generically without a personal workspace', async () => {
    const invalidUser = await signInWithoutBootstrap(uniqueEmail('invalid'), 'Invalid')
    await expect(bootstrap(invalidUser.client, { invite: tokenFor('missing') })).rejects.toThrow(
      'Invite could not be accepted',
    )
    expect(await listMine(invalidUser.client)).toEqual([])
  })

  test('a wrong-email invite fails generically without a personal workspace', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('failure-owner'), 'Owner')
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id

    const intendedEmail = uniqueEmail('intended')
    const wrongToken = tokenFor('wrong-email')
    await createInvite(owner.client, {
      workspaceId,
      email: intendedEmail,
      role: 'editor',
      token: wrongToken,
    })
    const wrongUser = await signInWithoutBootstrap(uniqueEmail('wrong'), 'Wrong')
    await expect(bootstrap(wrongUser.client, { invite: wrongToken })).rejects.toThrow(
      'Invite could not be accepted',
    )
    expect(await listMine(wrongUser.client)).toEqual([])
  })

  test('an expired invite fails generically without a personal workspace', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('failure-owner'), 'Owner')
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id

    const expiredEmail = uniqueEmail('expired')
    const expiredToken = tokenFor('expired')
    await createInvite(owner.client, {
      workspaceId,
      email: expiredEmail,
      role: 'editor',
      token: expiredToken,
      now: Date.now() - INVITE_LIFETIME_MS - 1,
    })
    const expiredUser = await signInWithoutBootstrap(expiredEmail, 'Expired')
    await expect(bootstrap(expiredUser.client, { invite: expiredToken })).rejects.toThrow(
      'Invite could not be accepted',
    )
    expect(await listMine(expiredUser.client)).toEqual([])
  })

  test('a revoked invite fails generically without a personal workspace', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('failure-owner'), 'Owner')
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id

    const revokedEmail = uniqueEmail('revoked')
    const revokedToken = tokenFor('revoked')
    const revoked = await createInvite(owner.client, {
      workspaceId,
      email: revokedEmail,
      role: 'viewer',
      token: revokedToken,
    })
    await mutate(owner.client, 'testing/invitations:revokeForTest', {
      internalKey: INTERNAL_KEY,
      inviteId: revoked._id,
      now: Date.now(),
    })
    const revokedUser = await signInWithoutBootstrap(revokedEmail, 'Revoked')
    await expect(bootstrap(revokedUser.client, { invite: revokedToken })).rejects.toThrow(
      'Invite could not be accepted',
    )
    expect(await listMine(revokedUser.client)).toEqual([])
  })

  test('a cross-user invite replay fails generically without a personal workspace', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('failure-owner'), 'Owner')
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id

    const acceptedEmail = uniqueEmail('accepted')
    const acceptedToken = tokenFor('accepted')
    await createInvite(owner.client, {
      workspaceId,
      email: acceptedEmail,
      role: 'editor',
      token: acceptedToken,
    })
    const accepted = await signInWithoutBootstrap(acceptedEmail, 'Accepted')
    await Promise.all([
      bootstrap(accepted.client, { invite: acceptedToken }),
      bootstrap(accepted.client, { invite: acceptedToken }),
    ])
    expect(await listMine(accepted.client)).toEqual([
      expect.objectContaining({
        role: 'editor',
        workspace: expect.objectContaining({ _id: workspaceId }),
      }),
    ])
    const replay = await signInWithoutBootstrap(uniqueEmail('replay'), 'Replay')
    await expect(bootstrap(replay.client, { invite: acceptedToken })).rejects.toThrow(
      'Invite could not be accepted',
    )
    expect(await listMine(replay.client)).toEqual([])
  })

  test('the staging expiry seam is internal-key guarded and limited to synthetic invite identities', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('expiry-seam-owner'),
      'Expiry Seam Owner',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    const email = `staging-e2e-${crypto.randomUUID()}@agentmail.to`
    const token = tokenFor('staging-expiry')
    const invite = await createInvite(owner.client, {
      workspaceId,
      email,
      role: 'viewer',
      token,
    })

    await expect(
      mutate(convex, 'testing/stagingE2e:expireInviteForTest', {
        internalKey: 'wrong-key',
        inviteId: invite._id,
        expectedEmail: email,
        now: Date.now(),
      }),
    ).rejects.toThrow('Unauthorized API internal key')
    await expect(
      mutate(convex, 'testing/stagingE2e:expireInviteForTest', {
        internalKey: INTERNAL_KEY,
        inviteId: invite._id,
        expectedEmail: uniqueEmail('not-synthetic'),
        now: Date.now(),
      }),
    ).rejects.toThrow('Only staging E2E synthetic identities are allowed')

    const expiredAt = Date.now()
    expect(
      await mutate(convex, 'testing/stagingE2e:expireInviteForTest', {
        internalKey: INTERNAL_KEY,
        inviteId: invite._id,
        expectedEmail: email,
        now: expiredAt,
      }),
    ).toEqual({ expiresAt: expiredAt - 1 })
    const invitee = await signInWithoutBootstrap(email, 'Expired Invitee')
    await expect(bootstrap(invitee.client, { invite: token })).rejects.toThrow(
      'Invite could not be accepted',
    )
    expect(await listMine(invitee.client)).toEqual([])
  })

  test('only owners manage one active invite per workspace and email', async () => {
    const owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('manage-owner'), 'Owner')
    const member = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('manage-member'),
      'Member',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
      userId: member.user._id,
      role: 'editor',
    })
    const email = uniqueEmail('managed')
    const first = await createInvite(owner.client, {
      workspaceId,
      email,
      role: 'editor',
      token: tokenFor('one'),
    })
    await expect(
      createInvite(owner.client, {
        workspaceId,
        email: email.toUpperCase(),
        role: 'viewer',
        token: tokenFor('two'),
      }),
    ).rejects.toThrow('An active invite already exists')
    await expect(
      query(member.client, 'testing/invitations:listForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId,
      }),
    ).rejects.toThrow('Requires owner access')
    const listed = (await query(owner.client, 'testing/invitations:listForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ email, role: 'editor' })
    expect(listed[0]).not.toHaveProperty('tokenHash')

    await mutate(owner.client, 'testing/invitations:revokeForTest', {
      internalKey: INTERNAL_KEY,
      inviteId: first._id,
      now: Date.now(),
    })
    await createInvite(owner.client, {
      workspaceId,
      email,
      role: 'viewer',
      token: tokenFor('replacement'),
    })
    const replaced = (await query(owner.client, 'testing/invitations:listForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ email: string; role: string; revokedAt?: number }>
    expect(
      replaced.map(({ email: recipient, role, revokedAt }) => ({
        recipient,
        role,
        revoked: revokedAt !== undefined,
      })),
    ).toEqual([
      { recipient: email, role: 'viewer', revoked: false },
      { recipient: email, role: 'editor', revoked: true },
    ])

    const tieAt = Date.now() + 100
    const tieA = await createInvite(owner.client, {
      workspaceId,
      email: uniqueEmail('managed-tie-a'),
      role: 'viewer',
      token: tokenFor('tie-a'),
      now: tieAt,
    })
    const tieB = await createInvite(owner.client, {
      workspaceId,
      email: uniqueEmail('managed-tie-b'),
      role: 'viewer',
      token: tokenFor('tie-b'),
      now: tieAt,
    })
    for (const inviteId of [tieA._id, tieB._id]) {
      await mutate(owner.client, 'testing/invitations:clearPaginationForTest', {
        internalKey: INTERNAL_KEY,
        inviteId,
      })
    }
    const backfilled = (await mutate(
      owner.client,
      'domains/internalAdmin/paginationOrder:backfill',
      {
        internalKey: INTERNAL_KEY,
        table: 'workspaceInvites',
        cursor: null,
      },
    )) as { patched: number; isDone: boolean }
    expect(backfilled.isDone).toBe(true)
    expect(backfilled.patched).toBeGreaterThanOrEqual(2)
    expect(
      await mutate(owner.client, 'domains/internalAdmin/paginationOrder:backfill', {
        internalKey: INTERNAL_KEY,
        table: 'workspaceInvites',
        cursor: null,
      }),
    ).toMatchObject({ patched: 0, isDone: true })
    const tied = (await query(owner.client, 'testing/invitations:listForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId,
    })) as Array<{ _id: string; createdAt: number }>
    expect(tied.filter(invite => invite.createdAt === tieAt).map(invite => invite._id)).toEqual(
      [tieA._id, tieB._id].sort().reverse(),
    )
  })

  test('the internal device API inspects and approves or denies codes for an actor', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('device-owner'),
      'Device Owner',
    )
    const approved = (await mutate(convex, 'domains/apiKeys/mutations:createDeviceCode', {
      clientName: 'Fixture Duet CLI',
    })) as {
      device_code: string
      user_code: string
    }
    expect(
      await query(convex, 'domains/apiKeys/deviceApi:inspect', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        userCode: approved.user_code,
        now: Date.now(),
      }),
    ).toMatchObject({
      userCode: approved.user_code,
      status: 'pending',
      clientName: 'Fixture Duet CLI',
    })
    expect(
      await mutate(convex, 'domains/apiKeys/deviceApi:approve', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        userCode: approved.user_code,
        now: Date.now(),
      }),
    ).toMatchObject({ status: 'approved' })

    const polled = (await mutate(convex, 'domains/apiKeys/api:pollDeviceCode', {
      internalKey: INTERNAL_KEY,
      deviceCode: approved.device_code,
      now: Date.now(),
    })) as { status: string; key: string; prefix: string }
    expect(polled.status).toBe('approved')
    expect(
      await query(convex, 'domains/apiKeys/api:resolveCredential', {
        internalKey: INTERNAL_KEY,
        hashedKey: await hashApiKey(polled.key),
        keyPrefix: polled.prefix,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: true,
      auth: { credentialKind: 'user', user: { id: owner.user._id } },
    })
    const keys = (await query(convex, 'testing/apiKeys:rawApiKeysForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<Record<string, unknown>>
    const issued = keys.find(key => key.prefix === polled.prefix)
    expect(issued).toMatchObject({ kind: 'user', userId: owner.user._id })
    expect(issued).not.toHaveProperty('scopes')
    expect(issued).not.toHaveProperty('workspaceIds')

    const denied = (await mutate(convex, 'domains/apiKeys/mutations:createDeviceCode', {
      clientName: 'Denied Fixture CLI',
    })) as {
      device_code: string
      user_code: string
    }
    expect(
      await mutate(convex, 'domains/apiKeys/deviceApi:deny', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        userCode: denied.user_code,
        now: Date.now(),
      }),
    ).toMatchObject({ status: 'denied' })
    expect(
      await query(convex, 'domains/apiKeys/deviceApi:inspect', {
        internalKey: INTERNAL_KEY,
        actorId: owner.user._id,
        userCode: denied.user_code,
        now: Date.now(),
      }),
    ).toMatchObject({ status: 'denied', clientName: 'Denied Fixture CLI' })
    expect(
      await mutate(convex, 'domains/apiKeys/api:pollDeviceCode', {
        internalKey: INTERNAL_KEY,
        deviceCode: denied.device_code,
        now: Date.now(),
      }),
    ).toEqual({ status: 'denied' })
  })

  test('sends the workspace role through the typed transactional email', async () => {
    const owner = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('send-invite-owner'),
      'Invite Owner',
    )
    const workspaceId = (await listMine(owner.client))[0]!.workspace._id
    const recipient = uniqueEmail('send-invite-recipient')

    const invitation = (await convex.action('domains/invitations/actions:createAndSendFromApi', {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      workspaceId,
      email: recipient,
      role: 'viewer',
    })) as { id: string; email: string; role: string }

    expect(invitation).toMatchObject({ email: recipient, role: 'viewer' })
    const deliveries = (await query(convex, 'testing/invitations:emailDeliveries', {
      internalKey: INTERNAL_KEY,
      to: recipient,
    })) as Array<Record<string, unknown>>
    expect(deliveries).toEqual([
      expect.objectContaining({
        kind: 'workspace_invite',
        subject: "You're invited to a Duet workspace",
        attempts: 1,
        status: 'sent',
      }),
    ])
    expect(deliveries[0]).not.toHaveProperty('html')
    expect(deliveries[0]).not.toHaveProperty('email')
  })

  test('magic-link delivery records are idempotent under a repeated request', async () => {
    const email = uniqueEmail('delivery')
    await convex.action('auth:signIn', { provider: 'email', params: { email } })
    await convex.action('auth:signIn', { provider: 'email', params: { email } })
    const deliveries = (await query(convex, 'testing/invitations:emailDeliveries', {
      internalKey: INTERNAL_KEY,
      to: email,
    })) as Array<Record<string, unknown>>
    expect(
      deliveries.map(({ attempts, status, providerId, kind, subject }) => ({
        attempts,
        status,
        providerId,
        kind,
        subject,
      })),
    ).toEqual([
      {
        attempts: 1,
        status: 'sent',
        providerId: 'test-capture',
        kind: 'auth_magic_link',
        subject: 'Sign in to Duet',
      },
    ])
    expect(deliveries[0]).not.toHaveProperty('html')
    expect(deliveries[0]).not.toHaveProperty('text')
    expect(deliveries[0]).not.toHaveProperty('email')
  })

  test('workspace bootstrap is unreachable except through the signup action', async () => {
    // A signed-in browser holds a Convex auth token, so a public bootstrap
    // mutation is callable straight from the devtools console — and it mints a
    // workspace, a trial grant and a VM. Anything the signup gate decides would
    // be bypassable while this stays public, so the mutation must be internal.
    //
    // Asserting on "not a public function" specifically, because a bare
    // rejection would also be satisfied by the old public mutation refusing an
    // unauthenticated caller — which is not the property under test.
    await expect(mutate(convex, 'domains/invitations/mutations:bootstrap', {})).rejects.toThrow(
      /public function/i,
    )
  })
})

async function signInWithoutBootstrap(
  email: string,
  name: string,
): Promise<SignedInUser & { token: string }> {
  await convex.action('auth:signIn', { provider: 'email', params: { email, name } })
  const result = await convex.action('auth:signIn', {
    provider: 'email',
    params: { email, name, code: AUTH_CODE },
  })
  const token = (result as { tokens?: { token?: string } }).tokens?.token
  if (!token) throw new Error('Auth token missing')
  const client = convex.clientWithAuth(token)
  return {
    client,
    token,
    user: (await query(client, 'domains/users/queries:current')) as UserRow,
  }
}

/**
 * Fires at the real `signUp` action rather than at `bootstrapUser`: the action's
 * args are a closed `v.object`, so a newly threaded field type-checks
 * everywhere and still 500s at runtime unless a call carries it over the wire.
 */
async function bootstrap(
  client: ConvexHttpClient,
  args: { invite?: string; workspaceName?: string } = {},
): Promise<{ workspaceId: string; workspaceSlug: string; invited: boolean }> {
  return (await act(client, 'domains/signupAbuse/actions:signUp', {
    ...(args.invite === undefined ? {} : { tokens: { invite: args.invite } }),
    ...(args.workspaceName === undefined ? {} : { workspaceName: args.workspaceName }),
  })) as { workspaceId: string; workspaceSlug: string; invited: boolean }
}

async function createInvite(
  client: ConvexHttpClient,
  args: {
    workspaceId: string
    email: string
    role: 'editor' | 'viewer'
    token: string
    now?: number
  },
): Promise<{ _id: string }> {
  return (await mutate(client, 'testing/invitations:createForTest', {
    internalKey: INTERNAL_KEY,
    ...args,
    now: args.now ?? Date.now(),
  })) as { _id: string }
}

async function rawInvites(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/invitations:rawInvites', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Array<Record<string, unknown>>
}

async function rawWorkspace(workspaceId: string): Promise<Record<string, unknown>> {
  return (await query(convex, 'testing/workspaces:rawWorkspaceByIdForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as Record<string, unknown>
}

async function rawUser(email: string): Promise<UserRow> {
  return (await query(convex, 'testing/workspaces:rawUserByEmailForTest', {
    internalKey: INTERNAL_KEY,
    email,
  })) as UserRow
}

async function mintSignupAttribution(campaignSlug: string): Promise<{ attributionId: string }> {
  return (await mutate(convex, 'domains/campaigns/api:mintAttribution', {
    internalKey: INTERNAL_KEY,
    campaignSlug,
    action: 'signup',
    signals: {},
    now: Date.now(),
  })) as { attributionId: string }
}

async function signupEvents(userId: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const events = capturedSignupEvents.filter(event => event.properties.distinct_id === userId)
    if (events.length > 0) return events
    await Bun.sleep(20)
  }
  throw new Error(`Signup event not delivered for ${userId}`)
}

async function listMine(client: ConvexHttpClient): Promise<WorkspaceRow[]> {
  return (await query(client, 'domains/workspaces/queries:listMine')) as WorkspaceRow[]
}

function tokenFor(label: string): string {
  return `${label}-${crypto.randomUUID()}-${crypto.randomUUID()}`
}

interface UserRow {
  _id: string
  email: string
  name?: string
  signupProcessedAt?: number
  acquisitionAttributionId?: string
}

interface WorkspaceRow {
  role: 'owner' | 'editor' | 'viewer'
  workspace: { _id: string; slug: string }
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}
