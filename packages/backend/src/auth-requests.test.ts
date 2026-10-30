import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConvexHttpClient } from 'convex/browser'

import { hashApiKey, SIGN_IN_CODE_TTL_SECONDS } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { grantableScopesForWorkspaceRole } from '../convex/domains/apiKeys/model'
import type { VerifyOutcome } from '../convex/domains/authRequests/actions'
import { SIGN_IN_ATTEMPT_BUDGET } from '../convex/domains/authRequests/model'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'auth-requests-internal-key'
const APP_URL = 'https://app-staging.duet.so'

interface RequestRow {
  requestId: string
  email: string
  codeHash?: string
  clientName?: string
  attemptsRemaining: number
  expiresAt: number
  consumedAt?: number
  supersededAt?: number
  createdAt: number
}

let convex: ConvexDevFixture
let sequence = 0

describe('the sign-in request record', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: APP_URL,
        // `SITE_URL` is left to mirror `DUET_APP_URL`, exactly as the secrets
        // rail sets it in production. That is the configuration in which the
        // library's bare-`SITE_URL` fallback is most dangerous: the origin is
        // legal, so only the path says the link goes nowhere.
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => await convex?.stop())

  test('start records who asked and which code redeems it', async () => {
    const email = uniqueSignInEmail('records')
    const now = Date.now()

    const started = await start({
      email: `  ${email.toUpperCase()} `,
      clientName: 'Claude Code',
      now,
    })

    // Captured first: an asymmetric matcher overwrites the field it matched on
    // the received object, so reading `started.requestId` after the assertion
    // hands back the matcher.
    const { requestId } = started
    expect(started).toEqual({
      requestId: expect.stringMatching(/^req_[0-9a-f]{32}$/),
      expiresIn: SIGN_IN_CODE_TTL_SECONDS,
    })
    const rows = await rawRequests(email)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestId,
      // Canonicalized on the way in: the row has to match the identifier the
      // library echoes back, or the emailed code never finds its request.
      email,
      clientName: 'Claude Code',
      attemptsRemaining: SIGN_IN_ATTEMPT_BUDGET,
      expiresAt: now + SIGN_IN_CODE_TTL_SECONDS * 1000,
      createdAt: now,
    })
    expect(rows[0]?.codeHash).toBe(await hashApiKey(TEST_AUTH_CODE))
    expect(JSON.stringify(rows[0])).not.toContain(TEST_AUTH_CODE)

    const deliveries = await emailDeliveries(email)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ kind: 'auth_magic_link', status: 'sent' })
  })

  test('blocked domains send no verification email through API or browser auth', async () => {
    const email = `blocked-${Date.now()}@satucrm.cloud`
    const now = Date.now()
    const started = await start({ email, now })
    expect(started).toEqual({
      requestId: expect.stringMatching(/^req_[0-9a-f]{32}$/),
      expiresIn: SIGN_IN_CODE_TTL_SECONDS,
    })
    expect(await rawRequests(email)).toEqual([])
    expect(await userProfile(email)).toBeNull()
    expect(await liveVerificationCodeCount(email)).toBe(0)
    expect(await emailDeliveries(email)).toEqual([])
    expect(await loadPending(started.requestId, now)).toBeNull()

    const browserEmail = `browser-${email}`
    await expect(
      convex.action('auth:signIn', { provider: 'email', params: { email: browserEmail } }),
    ).rejects.toThrow('Signup is not allowed for this email domain')
    expect(await userProfile(browserEmail)).toBeNull()
    expect(await liveVerificationCodeCount(browserEmail)).toBe(0)
    expect(await emailDeliveries(browserEmail)).toEqual([])
  })

  test('a second start supersedes the first, leaving one live code', async () => {
    const email = uniqueSignInEmail('supersede')
    const now = Date.now()

    const first = await start({ email, now })
    const second = await start({ email, now: now + 1 })

    expect(second.requestId).not.toBe(first.requestId)
    const rows = await rawRequests(email)
    expect(rows).toHaveLength(2)
    expect(rowFor(rows, first.requestId)?.supersededAt).toBe(now + 1)
    expect(rowFor(rows, second.requestId)?.supersededAt).toBeUndefined()

    // The reason superseding is the only honest option: the library deletes the
    // account's existing code on every start, so two open records could only
    // ever describe one live credential.
    expect(await liveVerificationCodeCount(email)).toBe(1)
    expect(await loadPending(first.requestId, now + 1)).toBeNull()
    expect(await loadPending(second.requestId, now + 1)).toMatchObject({
      requestId: second.requestId,
      email,
    })
    expect(await pendingForEmail(email, now + 1)).toMatchObject({ requestId: second.requestId })
  })

  test('wrong guesses exhaust the request budget', async () => {
    const email = uniqueSignInEmail('attempts')
    const now = Date.now()
    const { requestId } = await start({ email, now })

    const spent: number[] = []
    for (let attempt = 0; attempt < SIGN_IN_ATTEMPT_BUDGET; attempt += 1) {
      spent.push((await chargeFailedAttempt(requestId, now)).attemptsRemaining)
    }

    expect(spent).toEqual(
      Array.from(
        { length: SIGN_IN_ATTEMPT_BUDGET },
        (_, index) => SIGN_IN_ATTEMPT_BUDGET - index - 1,
      ),
    )
    expect(await loadPending(requestId, now)).toBeNull()
    expect(await chargeFailedAttempt(requestId, now).catch(error => String(error))).toContain(
      'Sign-in request is not pending',
    )
  })

  test('a request past its expiry is not pending, with nothing written to say so', async () => {
    const email = uniqueSignInEmail('expiry')
    const now = Date.now()
    const { requestId } = await start({ email, now })
    const expiresAt = now + SIGN_IN_CODE_TTL_SECONDS * 1000

    expect(await loadPending(requestId, expiresAt - 1)).not.toBeNull()
    expect(await loadPending(requestId, expiresAt)).toBeNull()
    expect(await pendingForEmail(email, expiresAt)).toBeNull()
    const row = rowFor(await rawRequests(email), requestId)
    expect(row?.consumedAt).toBeUndefined()
    expect(row?.supersededAt).toBeUndefined()
  })

  test('a consumed request is single-use', async () => {
    const email = uniqueSignInEmail('consume')
    const now = Date.now()
    const { requestId } = await start({ email, now })

    await consume(requestId, now)

    expect(rowFor(await rawRequests(email), requestId)?.consumedAt).toBe(now)
    expect(await loadPending(requestId, now)).toBeNull()
    expect(await consume(requestId, now).catch(error => String(error))).toContain(
      'Sign-in request is not pending',
    )
  })

  test('an invalid sign-in callback is refused before email delivery is accepted', async () => {
    const email = uniqueSignInEmail('bare-site-url')
    await start({ email, now: Date.now() })
    const delivered = (await emailDeliveries(email)).length

    // Exactly what `start` would produce if it stopped passing `redirectTo`:
    // the library's bare-`SITE_URL` fallback, which is a URL the web app has no
    // route for.
    const refusal = await convex
      .action('auth:signIn', { provider: 'email', params: { email } })
      .catch(error => String(error))

    expect(refusal).toContain('does not reach a sign-in page')
    expect(await emailDeliveries(email)).toHaveLength(delivered)
  })

  test('start refuses a caller without the internal key', async () => {
    const refusal = await convex
      .action('domains/authRequests/actions:start', {
        internalKey: 'wrong',
        email: uniqueSignInEmail('unauthorized'),
        now: Date.now(),
      })
      .catch(error => String(error))

    expect(refusal).toContain('Unauthorized API internal key')
  })

  describe('the verify choreography', () => {
    // Every code in this fixture is the same constant, so two accounts holding a
    // live code each collide on the vendor's `code` index — which it reads with
    // `.unique()`. Tests that only start a sign-in leave such a row behind, and
    // so does any test that fails halfway, so each test that redeems clears the
    // ground first rather than inheriting the last one's leftovers.
    beforeEach(async () => {
      await mutate(convex, 'testing/authRequests:discardVerificationCodesForTest', {
        internalKey: INTERNAL_KEY,
      })
    })

    test('a first sign-in names the human, names the workspace, and hands back an owner key', async () => {
      const email = uniqueSignInEmail('first-sign-in')
      const now = Date.now()
      const { requestId } = await start({ email, clientName: 'Claude Code', now })

      const outcome = await verify({
        requestId,
        code: TEST_AUTH_CODE,
        name: 'Casey Jones',
        workspaceName: 'Casey Labs',
        now,
      })

      if (outcome.kind !== 'issued') throw new Error(`expected an issued key, got ${outcome.kind}`)
      expect(outcome.created).toBe(true)
      expect(outcome.workspace.name).toBe('Casey Labs')
      expect(outcome.accessToken.startsWith(outcome.prefix)).toBe(true)
      // The role's whole grant, assembled by the one function that answers that
      // question — not a list this test or the action wrote out by hand.
      expect(outcome.scopes).toEqual(
        grantableScopesForWorkspaceRole(outcome.workspace.slug, 'owner'),
      )
      expect(await userProfile(email)).toEqual({ email, name: 'Casey Jones' })
      // Single-use, and the code went with it.
      expect(await loadPending(requestId, now)).toBeNull()
      expect(await liveVerificationCodeCount(email)).toBe(0)
    })

    test('a returning human with one workspace is bound to it, creating nothing', async () => {
      const email = uniqueSignInEmail('returning-one')
      const first = await signIn(email, 'Casey Jones', 'Casey Labs')

      const now = Date.now()
      const { requestId } = await start({ email, now })
      const outcome = await verify({ requestId, code: TEST_AUTH_CODE, now })

      if (outcome.kind !== 'issued') throw new Error(`expected an issued key, got ${outcome.kind}`)
      expect(outcome.created).toBe(false)
      expect(outcome.workspace).toEqual(place(first.workspace))
    })

    test('a name supplied on a bind never renames the human who is already there', async () => {
      const named = uniqueSignInEmail('bind-named')
      await signIn(named, 'Original Name', 'Original Labs')

      const outcome = await verify({
        requestId: (await start({ email: named, now: Date.now() })).requestId,
        code: TEST_AUTH_CODE,
        name: 'Renamed By An Agent',
        now: Date.now(),
      })

      expect(outcome.kind).toBe('issued')
      expect(await userProfile(named)).toEqual({ email: named, name: 'Original Name' })

      // The converse, which is what actually pins the branch: a returning human
      // with no stored name does not acquire one either. If `verify` ever passed
      // `name` through on a bind, this is the assertion that would go red first —
      // `profileFieldsToKeep` would happily write it.
      const nameless = uniqueSignInEmail('bind-nameless')
      await signInWithoutName(nameless)
      const second = await verify({
        requestId: (await start({ email: nameless, now: Date.now() })).requestId,
        code: TEST_AUTH_CODE,
        name: 'Named By An Agent',
        now: Date.now(),
      })

      expect(second.kind).toBe('issued')
      expect(await userProfile(nameless)).toEqual({ email: nameless })
    })

    test('a wrong code learns nothing about the account it names', async () => {
      // The whole-spec review found this open: resolving the workspace before
      // proving the code handed anyone who knew an address a 409 listing every
      // workspace that person belongs to, and a 403-vs-400 membership oracle
      // for any slug they guessed — both free, because neither branch spends an
      // attempt. `start` is unauthenticated and deliberately says nothing;
      // this is the other end of the same firewall.
      const email = uniqueSignInEmail('no-oracle')
      const user = await signIn(email, 'Two Workspaces', 'Oracle Labs')
      const second = await createWorkspace(user.client, 'oracle-second')

      const now = Date.now()
      const { requestId } = await start({ email, now })

      // Two live workspaces: the pre-fix code answered `ambiguous` with both.
      const guessed = await verify({ requestId, code: 'ZZZZ-ZZZZ', now })
      expect(guessed.kind).toBe('invalid_code')

      // And naming a workspace they are not in must not distinguish itself
      // from naming one they are.
      const outsider = await verify({
        requestId,
        code: 'ZZZZ-ZZZZ',
        workspaceSlug: 'a-workspace-they-do-not-belong-to',
        now,
      })
      const insider = await verify({
        requestId,
        code: 'ZZZZ-ZZZZ',
        workspaceSlug: second.slug,
        now,
      })
      expect(outsider.kind).toBe('invalid_code')
      expect(insider.kind).toBe('invalid_code')
    })

    test('several workspaces refuse to be guessed at, and the code survives the refusal', async () => {
      const email = uniqueSignInEmail('ambiguous')
      const user = await signIn(email, 'Two Workspaces', 'First Labs')
      const second = await createWorkspace(user.client, 'ambiguous-second')

      const now = Date.now()
      const { requestId } = await start({ email, now })
      const refusal = await verify({ requestId, code: TEST_AUTH_CODE, now })

      if (refusal.kind !== 'ambiguous') throw new Error(`expected ambiguity, got ${refusal.kind}`)
      expect(refusal.workspaces).toEqual(
        expect.arrayContaining([
          { slug: user.workspace.slug, name: user.workspace.name, role: 'owner' },
          { slug: second.slug, name: second.name, role: 'owner' },
        ]),
      )
      expect(refusal.workspaces).toHaveLength(2)

      // The assertion the ordering exists for: nothing was spent answering the
      // question, so the same code redeems once the caller says which one.
      expect(await loadPending(requestId, now)).not.toBeNull()
      expect(await liveVerificationCodeCount(email)).toBe(1)
      const outcome = await verify({
        requestId,
        code: TEST_AUTH_CODE,
        workspaceSlug: second.slug,
        now,
      })
      if (outcome.kind !== 'issued') throw new Error(`expected an issued key, got ${outcome.kind}`)
      expect(outcome.workspace).toEqual(place(second))
      expect(outcome.created).toBe(false)
    })

    test('a workspace the human does not belong to is refused, and the code survives that too', async () => {
      const email = uniqueSignInEmail('forbidden')
      const user = await signIn(email, 'Not A Member', 'Own Labs')
      const stranger = await signIn(uniqueSignInEmail('forbidden-owner'), 'Owner', 'Their Labs')

      const now = Date.now()
      const { requestId } = await start({ email, now })
      const refusal = await verify({
        requestId,
        code: TEST_AUTH_CODE,
        workspaceSlug: stranger.workspace.slug,
        now,
      })

      expect(refusal).toEqual({ kind: 'forbidden' })
      expect(await liveVerificationCodeCount(email)).toBe(1)
      const outcome = await verify({ requestId, code: TEST_AUTH_CODE, now })
      if (outcome.kind !== 'issued') throw new Error(`expected an issued key, got ${outcome.kind}`)
      expect(outcome.workspace).toEqual(place(user.workspace))
    })

    test.each(['editor', 'viewer'] as const)(
      'a %s sign-in grants its role without owner reach',
      async role => {
        const owner = await signIn(uniqueSignInEmail('role-owner'), 'Owner', 'Shared Labs')
        const memberEmail = uniqueSignInEmail(`role-${role}`)
        const member = await signIn(memberEmail, 'Member', 'Member Labs')
        await mutate(owner.client, 'testing/workspaces:addWorkspaceMemberForTest', {
          internalKey: INTERNAL_KEY,
          workspaceId: owner.workspace._id,
          userId: member.userId,
          role,
        })

        const now = Date.now()
        const { requestId } = await start({ email: memberEmail, now })
        const outcome = await verify({
          requestId,
          code: TEST_AUTH_CODE,
          workspaceSlug: owner.workspace.slug,
          now,
        })

        if (outcome.kind !== 'issued')
          throw new Error(`expected an issued key, got ${outcome.kind}`)
        expect(outcome.scopes).toEqual(grantableScopesForWorkspaceRole(owner.workspace.slug, role))
        expect(outcome.scopes.some(scope => scope.endsWith(':admin'))).toBe(false)
        expect(outcome.scopes.some(scope => scope.endsWith(':members'))).toBe(false)
        expect(outcome.scopes).toContain(`ws:${owner.workspace.slug}:sessions`)
      },
    )

    test('wrong guesses walk the budget down, and the last one takes the code with it', async () => {
      const email = uniqueSignInEmail('wrong-code')
      const now = Date.now()
      const { requestId } = await start({ email, now })

      const spent: number[] = []
      for (let attempt = 0; attempt < SIGN_IN_ATTEMPT_BUDGET; attempt += 1) {
        const outcome = await verify({ requestId, code: 'WRNG-CODE', now })
        if (outcome.kind !== 'invalid_code') {
          throw new Error(`expected a wrong code, got ${outcome.kind}`)
        }
        spent.push(outcome.attemptsRemaining)
      }

      expect(spent).toEqual(
        Array.from(
          { length: SIGN_IN_ATTEMPT_BUDGET },
          (_, index) => SIGN_IN_ATTEMPT_BUDGET - index - 1,
        ),
      )
      // A budget that has run out ends the sign-in on both sides. The library
      // dates its code from its own clock and counts nothing, so leaving it live
      // would leave a forty-bit secret with no counter behind it.
      expect(await liveVerificationCodeCount(email)).toBe(0)
      expect(await verify({ requestId, code: TEST_AUTH_CODE, now })).toEqual({ kind: 'expired' })
    })

    test('a code minted for one request cannot be spent against another', async () => {
      const impostorEmail = uniqueSignInEmail('cross-request-impostor')
      const impostor = await start({ email: impostorEmail, now: Date.now() })
      // Retire the impostor's own code so the only live one belongs to somebody
      // else. In production the codes differ and the hash check refuses first;
      // this fixture pins every code to one constant, which is precisely what
      // makes it able to exercise the identity check underneath.
      await convex.action('auth:signIn', { params: { code: TEST_AUTH_CODE } })

      const victimEmail = uniqueSignInEmail('cross-request-victim')
      await start({ email: victimEmail, now: Date.now() })

      const outcome = await verify({
        requestId: impostor.requestId,
        code: TEST_AUTH_CODE,
        now: Date.now(),
      })

      expect(outcome).toEqual({
        kind: 'invalid_code',
        attemptsRemaining: SIGN_IN_ATTEMPT_BUDGET - 1,
      })
    })

    test('an unknown request is expired, and verify refuses a caller without the internal key', async () => {
      const unknown = await verify({
        requestId: 'req_missing',
        code: TEST_AUTH_CODE,
        now: Date.now(),
      })
      expect(unknown).toEqual({ kind: 'expired' })

      const refusal = await convex
        .action('domains/authRequests/actions:verify', {
          internalKey: 'wrong',
          requestId: 'req_missing',
          code: TEST_AUTH_CODE,
          now: Date.now(),
        })
        .catch(error => String(error))

      expect(refusal).toContain('Unauthorized API internal key')
    })
  })
})

function uniqueSignInEmail(label: string): string {
  sequence += 1
  return `signin-${label}-${sequence}-${Date.now()}@signin-${label}-${sequence}-${Date.now()}.example`
}

async function verify(args: {
  requestId: string
  code: string
  name?: string
  workspaceName?: string
  workspaceSlug?: string
  now: number
}): Promise<VerifyOutcome> {
  return (await convex.action('domains/authRequests/actions:verify', {
    internalKey: INTERNAL_KEY,
    ...args,
  })) as VerifyOutcome
}

interface TestWorkspace {
  _id: string
  slug: string
  name: string
}

interface TestUser {
  client: ConvexHttpClient
  userId: string
  workspace: TestWorkspace
}

/** What `verify` reports about a workspace — the identity, without the row id. */
function place(workspace: TestWorkspace): { slug: string; name: string } {
  return { slug: workspace.slug, name: workspace.name }
}

/**
 * A human who has signed in once through this very rail, so their account
 * carries the name they gave and their workspace the name they chose.
 *
 * Deliberately not `signInWithMagicLink`: that is the browser path, and the
 * library discards `name` on it — every account it creates is nameless, which
 * is the live defect this feature fixes. The extra magic-link sign-in
 * afterwards exists only to get a Convex-authenticated client for the fixture
 * mutations; by then the account and its workspace already exist, so it
 * bootstraps nothing.
 */
async function signIn(email: string, name: string, workspaceName: string): Promise<TestUser> {
  const started = await start({ email, now: Date.now() })
  const outcome = await verify({
    requestId: started.requestId,
    code: TEST_AUTH_CODE,
    name,
    workspaceName,
    now: Date.now(),
  })
  if (outcome.kind !== 'issued') throw new Error(`fixture sign-in failed: ${outcome.kind}`)
  return await clientFor(email, outcome.workspace.slug)
}

/** The browser path, which never records a name. */
async function signInWithoutName(email: string): Promise<TestUser> {
  return await clientFor(email)
}

async function clientFor(email: string, slug?: string): Promise<TestUser> {
  const { client, user } = await signInWithMagicLink<{ _id: string }>(
    convex,
    email,
    'discarded by the library',
  )
  const workspaces = (await query(client, 'domains/workspaces/queries:listMine')) as Array<{
    workspace: TestWorkspace
  }>
  const workspace =
    slug === undefined
      ? workspaces[0]?.workspace
      : workspaces.find(row => row.workspace.slug === slug)?.workspace
  if (workspace === undefined) throw new Error(`fixture has no workspace ${slug ?? ''}`)
  return { client, userId: user._id, workspace }
}

async function createWorkspace(client: ConvexHttpClient, label: string): Promise<TestWorkspace> {
  sequence += 1
  const slug = `${label}-${sequence}-${Date.now()}`
  const _id = (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name: `${label} fixture`,
  })) as string
  return { _id, slug, name: `${label} fixture` }
}

async function userProfile(email: string): Promise<{ email: string; name?: string } | null> {
  return (await query(convex, 'testing/authRequests:userForTest', {
    internalKey: INTERNAL_KEY,
    email,
  })) as { email: string; name?: string } | null
}

async function start(args: {
  email: string
  clientName?: string
  name?: string
  now: number
}): Promise<{ requestId: string; expiresIn: number }> {
  return (await convex.action('domains/authRequests/actions:start', {
    internalKey: INTERNAL_KEY,
    ...args,
  })) as { requestId: string; expiresIn: number }
}

async function rawRequests(email: string): Promise<RequestRow[]> {
  return (await query(convex, 'testing/authRequests:rawRequests', {
    internalKey: INTERNAL_KEY,
    email,
  })) as RequestRow[]
}

function rowFor(rows: RequestRow[], requestId: string): RequestRow | undefined {
  return rows.find(row => row.requestId === requestId)
}

async function loadPending(requestId: string, now: number): Promise<unknown> {
  return await query(convex, 'testing/authRequests:loadPendingForTest', {
    internalKey: INTERNAL_KEY,
    requestId,
    now,
  })
}

async function pendingForEmail(email: string, now: number): Promise<unknown> {
  return await query(convex, 'testing/authRequests:pendingForEmailForTest', {
    internalKey: INTERNAL_KEY,
    email,
    now,
  })
}

async function chargeFailedAttempt(
  requestId: string,
  now: number,
): Promise<{ attemptsRemaining: number }> {
  return (await mutate(convex, 'testing/authRequests:chargeFailedAttemptForTest', {
    internalKey: INTERNAL_KEY,
    requestId,
    now,
  })) as { attemptsRemaining: number }
}

async function consume(requestId: string, now: number): Promise<void> {
  await mutate(convex, 'testing/authRequests:consumeForTest', {
    internalKey: INTERNAL_KEY,
    requestId,
    now,
  })
}

async function liveVerificationCodeCount(email: string): Promise<number> {
  return (await query(convex, 'testing/authRequests:liveVerificationCodeCount', {
    internalKey: INTERNAL_KEY,
    email,
  })) as number
}

async function emailDeliveries(to: string): Promise<Array<Record<string, unknown>>> {
  return (await query(convex, 'testing/invitations:emailDeliveries', {
    internalKey: INTERNAL_KEY,
    to,
  })) as Array<Record<string, unknown>>
}
