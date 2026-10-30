import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import { SIGN_IN_CODE_TTL_SECONDS } from '@repo/contract'

import type { DataModel, Doc } from '../../_generated/dataModel'

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>

/**
 * How many wrong codes one request tolerates before it is dead.
 *
 * The whole reason this table exists: `@convex-dev/auth` keys its rate limiter
 * on `params.email`, and a code-only verify call sends none — so without this
 * counter a forty-bit code faces an unlimited guesser. Five is the budget the
 * wire ledger publishes (`attempts_remaining: 4` after one failure).
 */
export const SIGN_IN_ATTEMPT_BUDGET = 5

/** A pending request, projected. `codeHash` is present because pending implies bound. */
export interface SignInRequest {
  requestId: string
  email: string
  codeHash: string
  clientName?: string
  attemptsRemaining: number
  expiresAt: number
  createdAt: number
}

/**
 * Trim and lowercase, and deliberately nothing else.
 *
 * `normalizeEmail` folds Gmail dots and plus-tags because it decides which
 * *account* an address belongs to. This row is not an account: it has to match
 * the identifier `auth:signIn` echoes back to the send callback byte for byte,
 * or the emailed code can never find its request. Folding here would break that
 * join for every address the folding rewrites.
 */
export function canonicalSignInEmail(email: string): string {
  const canonical = email.trim().toLowerCase()
  if (canonical === '') throw new Error('A sign-in request needs an email address')
  return canonical
}

/**
 * Start a sign-in for this address, closing any earlier one.
 *
 * Superseding rather than refusing is forced by the library:
 * `createVerificationCode` deletes the account's existing code, so a second
 * `start` leaves exactly one live code no matter what we do. Refusing the
 * second call would keep a record alive that can never be redeemed *and* would
 * make `POST /v1/auth/email/start` answer something other than the 202 its
 * contract promises — which is also its defence against enumeration. So the
 * record set follows the code set: one live code, one open request.
 *
 * The attempt budget therefore resets on every `start`. The per-email rate
 * limit on `start` is what bounds how often that can happen.
 */
export async function createSignInRequest(
  ctx: MutationCtx,
  args: { email: string; clientName?: string; now: number },
): Promise<{ requestId: string; expiresIn: number }> {
  const email = canonicalSignInEmail(args.email)
  for (const open of await openRowsForEmail(ctx, email, args.now)) {
    await ctx.db.patch(open._id, { supersededAt: args.now })
  }
  const requestId = generateSignInRequestId()
  await ctx.db.insert('authSignInRequests', {
    requestId,
    email,
    attemptsRemaining: SIGN_IN_ATTEMPT_BUDGET,
    expiresAt: args.now + SIGN_IN_CODE_TTL_SECONDS * 1000,
    createdAt: args.now,
    ...(args.clientName === undefined ? {} : { clientName: args.clientName }),
  })
  return { requestId, expiresIn: SIGN_IN_CODE_TTL_SECONDS }
}

/**
 * Teach the open request for this address which code redeems it.
 *
 * Called from the one place the plaintext code is ever visible — the provider's
 * send callback — and only ever with its hash. A browser sign-in reaches the
 * same callback with no open request and binds nothing, which is how the two
 * rails share one provider without sharing state.
 *
 * If two `start` calls for one address genuinely interleave, the later bind
 * wins and one record may end up holding the hash of a code that is no longer
 * live. That fails closed: verification rejects the code and the human starts
 * again.
 *
 * Returns `clientName` alongside the verdict because the row is already loaded
 * here and the send callback is the one place that needs it — reading it again
 * from there would be a second query for a fact this mutation is holding.
 */
export async function bindCodeToSignInRequest(
  ctx: MutationCtx,
  args: { email: string; codeHash: string; now: number },
): Promise<{ bound: boolean; clientName?: string }> {
  const [open] = await openRowsForEmail(ctx, canonicalSignInEmail(args.email), args.now)
  if (open === undefined) return { bound: false }
  await ctx.db.patch(open._id, { codeHash: args.codeHash })
  return { bound: true, ...(open.clientName === undefined ? {} : { clientName: open.clientName }) }
}

export async function loadPendingSignInRequest(
  ctx: QueryCtx,
  args: { requestId: string; now: number },
): Promise<SignInRequest | null> {
  const row = await rowByRequestId(ctx, args.requestId)
  return row !== null && isPending(row, args.now) ? project(row) : null
}

/** The open, code-bearing request for an address, if there is one. */
export async function pendingRequestForEmail(
  ctx: QueryCtx,
  args: { email: string; now: number },
): Promise<SignInRequest | null> {
  const [open] = await openRowsForEmail(ctx, canonicalSignInEmail(args.email), args.now)
  return open !== undefined && isPending(open, args.now) ? project(open) : null
}

/**
 * Spend one guess, and end the request if that was the last one.
 *
 * Throws unless the request is pending — load it first.
 *
 * Exhaustion ends *both* halves of the sign-in, not just this record. The
 * library dates its code from its own clock and nothing counts guesses against
 * it (`verifyCodeAndSignIn.js:22` keys its limiter on an absent `params.email`),
 * so a record that dies twenty seconds after `start` would otherwise leave a
 * forty-bit code redeemable for the rest of the TTL with the only counter in the
 * system already at zero. The person whose budget was burned has to run `start`
 * again regardless, and that mints a fresh code — so nothing legitimate is lost.
 */
export async function chargeFailedAttempt(
  ctx: MutationCtx,
  args: { requestId: string; now: number },
): Promise<{ attemptsRemaining: number }> {
  const row = await requirePending(ctx, args)
  const attemptsRemaining = Math.max(0, row.attemptsRemaining - 1)
  await ctx.db.patch(row._id, {
    attemptsRemaining,
    ...(attemptsRemaining === 0 ? { consumedAt: args.now } : {}),
  })
  if (attemptsRemaining === 0) await discardLiveCodeForEmail(ctx, row.email)
  return { attemptsRemaining }
}

/**
 * Retire whatever code `@convex-dev/auth` still holds for this address.
 *
 * Reading and deleting the vendor's row, never re-implementing it: the code and
 * its single-use semantics stay the library's, and this only shortens the life
 * of one it already considers spent. `createVerificationCode` keeps at most one
 * row per account, so the `take` bound is generosity, not a real page.
 */
async function discardLiveCodeForEmail(ctx: MutationCtx, email: string): Promise<void> {
  const account = await ctx.db
    .query('authAccounts')
    .withIndex('providerAndAccountId', q =>
      q.eq('provider', 'email').eq('providerAccountId', email),
    )
    .unique()
  if (account === null) return
  const codes = await ctx.db
    .query('authVerificationCodes')
    .withIndex('accountId', q => q.eq('accountId', account._id))
    .take(10)
  for (const code of codes) await ctx.db.delete(code._id)
}

/** Single-use, like the code it describes. */
export async function consumeSignInRequest(
  ctx: MutationCtx,
  args: { requestId: string; now: number },
): Promise<void> {
  const row = await requirePending(ctx, args)
  await ctx.db.patch(row._id, { consumedAt: args.now })
}

async function requirePending(
  ctx: MutationCtx,
  args: { requestId: string; now: number },
): Promise<Doc<'authSignInRequests'>> {
  const row = await rowByRequestId(ctx, args.requestId)
  if (row === null || !isPending(row, args.now)) throw new Error('Sign-in request is not pending')
  return row
}

async function rowByRequestId(
  ctx: QueryCtx,
  requestId: string,
): Promise<Doc<'authSignInRequests'> | null> {
  return await ctx.db
    .query('authSignInRequests')
    .withIndex('by_requestId', q => q.eq('requestId', requestId))
    .unique()
}

/**
 * Every request for this address that has not ended, newest first.
 *
 * Bounded rather than collected: the per-email rate limit on `start` keeps this
 * in single digits, and a page of fifty is far past anything legitimate.
 */
async function openRowsForEmail(
  ctx: QueryCtx,
  email: string,
  now: number,
): Promise<Doc<'authSignInRequests'>[]> {
  const rows = await ctx.db
    .query('authSignInRequests')
    .withIndex('by_email', q => q.eq('email', email))
    .order('desc')
    .take(50)
  return rows.filter(row => isOpen(row, now))
}

/** Not ended and not stale — but nothing has bound a code to it yet. */
function isOpen(row: Doc<'authSignInRequests'>, now: number): boolean {
  return row.consumedAt === undefined && row.supersededAt === undefined && row.expiresAt > now
}

function isPending(row: Doc<'authSignInRequests'>, now: number): boolean {
  return isOpen(row, now) && row.codeHash !== undefined && row.attemptsRemaining > 0
}

function project(row: Doc<'authSignInRequests'>): SignInRequest {
  if (row.codeHash === undefined) throw new Error('Sign-in request has no code bound')
  return {
    requestId: row.requestId,
    email: row.email,
    codeHash: row.codeHash,
    attemptsRemaining: row.attemptsRemaining,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    ...(row.clientName === undefined ? {} : { clientName: row.clientName }),
  }
}

const REQUEST_ID_BYTES = 16

/** Mint the enumeration-safe handle returned when a start is refused. */
export function generateSignInRequestId(): string {
  const bytes = new Uint8Array(REQUEST_ID_BYTES)
  crypto.getRandomValues(bytes)
  return `req_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
