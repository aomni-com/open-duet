import { generateKeyPairSync } from 'node:crypto'

import { type ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import { type ConvexDevFixture } from './convex-dev.ts'

/**
 * The fixture sign-in code, shared by every suite that boots a deployment with
 * `DUET_TEST_AUTH_EMAIL=1`.
 *
 * It has to satisfy `HumanEntryCodeSchema` like any other code, because the
 * routes that accept one validate its shape. Exported so the ~45 suites that
 * need it stop each owning a copy.
 */
export const TEST_AUTH_CODE = 'TEST-CODE'
const internalKeysByClient = new WeakMap<ConvexHttpClient, string>()

export interface SignedInUser<UserRow = unknown> {
  client: ConvexHttpClient
  user: UserRow
}

export interface AuthKeyOptions {
  kid?: string
  alg?: string
}

export interface IssuedTestApiKey {
  key: string
  prefix: string
  expiresAt?: number
}

export async function signInWithMagicLink<UserRow = unknown>(
  convex: ConvexDevFixture,
  email: string,
  name: string,
  authCode = TEST_AUTH_CODE,
  inviteToken?: string,
): Promise<SignedInUser<UserRow>> {
  await convex.action('auth:signIn', {
    provider: 'email',
    params: { email, name },
  })
  const result = await convex.action('auth:signIn', {
    params: { code: authCode },
  })
  const tokens = (result as { tokens?: { token: string; refreshToken: string } | null }).tokens
  if (typeof tokens?.token !== 'string') throw new Error('magic link sign-in did not return tokens')
  const client = convex.clientWithAuth(tokens!.token)
  if (convex.internalKey !== undefined) internalKeysByClient.set(client, convex.internalKey)
  await act(
    client,
    'domains/signupAbuse/actions:signUp',
    inviteToken === undefined ? {} : { tokens: { invite: inviteToken } },
  )
  return { client, user: (await query(client, 'domains/users/queries:current', {})) as UserRow }
}

export async function issueKey(
  client: ConvexHttpClient,
  options: { name?: string; expiresAt?: number } = {},
): Promise<IssuedTestApiKey> {
  const internalKey = internalKeysByClient.get(client)
  if (internalKey === undefined)
    throw new Error('Signed-in test client is missing its internal key')
  const actor = (await query(client, 'domains/users/queries:current', {})) as { _id: string }
  const issued = (await mutate(client, 'domains/apiKeys/userApi:issue', {
    internalKey,
    actorId: actor._id,
    name: options.name ?? 'API key',
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    now: Date.now(),
  })) as { key: string; record: Omit<IssuedTestApiKey, 'key'> }
  return { key: issued.key, ...issued.record }
}

export function query(
  convex: ConvexDevFixture,
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>
export function query(
  client: ConvexHttpClient,
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>
export function query(
  convexOrClient: ConvexDevFixture | ConvexHttpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if ('clientWithAuth' in convexOrClient) return convexOrClient.query(name, args)
  return convexOrClient.query(makeFunctionReference(name) as FunctionReference<'query'>, args)
}

export function mutate(
  convex: ConvexDevFixture,
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>
export function mutate(
  client: ConvexHttpClient,
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>
export function mutate(
  convexOrClient: ConvexDevFixture | ConvexHttpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if ('clientWithAuth' in convexOrClient) return convexOrClient.mutation(name, args)
  return convexOrClient.mutation(makeFunctionReference(name) as FunctionReference<'mutation'>, args)
}

export function act(
  convex: ConvexDevFixture,
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>
export function act(
  client: ConvexHttpClient,
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown>
export function act(
  convexOrClient: ConvexDevFixture | ConvexHttpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if ('clientWithAuth' in convexOrClient) return convexOrClient.action(name, args)
  return convexOrClient.action(makeFunctionReference(name) as FunctionReference<'action'>, args)
}

export function generateAuthKeys(
  options: AuthKeyOptions = {},
): Record<'JWT_PRIVATE_KEY' | 'JWKS', string> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privatePem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
    .trimEnd()
    .replace(/\n/g, ' ')
  const publicJwk = publicKey.export({ format: 'jwk' })
  return {
    JWT_PRIVATE_KEY: privatePem,
    JWKS: JSON.stringify({ keys: [{ ...publicJwk, ...options, use: 'sig' }] }),
  }
}

/* Each synthetic account gets a domain of its own, not a mailbox on one shared
   domain. The signup gate withholds the trial from the sixth signup a domain
   makes in an hour — that is what a trial farm looks like — and to it a test
   file minting every account at `@example.com` is exactly that farm: from the
   sixth account on, every workspace is born paused with no grant, and a suite
   fails in ways a single test never can. `.example` is reserved for this
   (RFC 2606) and is the shape the abuse tests already mint for themselves. */
export function uniqueEmail(prefix: string): string {
  const nonce = crypto.randomUUID()
  // The nonce lives in both halves: callers that re-domain an address for a
  // company account (`.replace(/@[^@]+$/, '@aomni.com')`) must keep a unique
  // mailbox, and the domain must be unique for the gate.
  return `${prefix}-${nonce}@${prefix}-${nonce}.example`
}

/**
 * Kills the product's async provisioning actors for one workspace so a test
 * can drive prepare->register manually with no one racing it. Workspace birth
 * and operator reprovision each start an action-retrier run whose attempts
 * re-prepare provisioning tokens — and can rotate the vm token AFTER a test's
 * successful manual registration. Cancelling is not enough by itself: each
 * run's onComplete mutation is what clears its run-id field on the workspace
 * row, so this helper polls until both fields are gone. After it returns, the
 * pair is deterministically unraced — no retries needed at the call site.
 */
export async function settleWorkspaceProvisioning(
  convexOrClient: ConvexDevFixture | ConvexHttpClient,
  args: { internalKey: string; workspaceId: string },
  timeoutMs = 30_000,
): Promise<void> {
  // The overloads of mutate/query take each client shape separately; they
  // re-discriminate at runtime, so collapsing the union here is sound.
  const client = convexOrClient as ConvexHttpClient
  const settled = (await mutate(
    client,
    'testing/workspaces:settleWorkspaceProvisioningForTest',
    args,
  )) as { pendingRuns: number }
  if (settled.pendingRuns === 0) return
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const workspace = (await query(client, 'testing/workspaces:rawWorkspaceByIdForTest', {
      internalKey: args.internalKey,
      workspaceId: args.workspaceId,
    })) as { vmAttachRunId?: string; vmTeardownRunId?: string }
    if (workspace.vmAttachRunId === undefined && workspace.vmTeardownRunId === undefined) return
    if (Date.now() > deadline) {
      throw new Error('Workspace provisioning runs did not settle within the timeout')
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
