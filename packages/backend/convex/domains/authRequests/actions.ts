import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import {
  AUTH_SIGN_IN_PATH,
  hashApiKey,
  resolveSignInWorkspace,
  SIGN_IN_CODE_TTL_SECONDS,
  type SignInWorkspaceChoice,
} from '@repo/contract'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import { action } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import { completeSignUp, SignupDomainRefusalError } from '../signupAbuse/actions'
import { isBlockedEmailDomain } from '../signupAbuse/blockedEmailDomains'
import { normalizeEmail } from '../users/identity'
import { canonicalSignInEmail, generateSignInRequestId } from './model'

const signIn = makeFunctionReference<'action'>('auth:signIn')

/**
 * Where the link in the sign-in email points.
 *
 * Not optional in practice. Omitted, `signIn.js` falls back to bare `SITE_URL`
 * and emails `https://app.duet.so?code=…`, which no route in the web app
 * handles; a non-app origin makes `authRedirectUrl` throw. That leaves the two
 * app-origin paths that can finish a sign-in, and `/sign-in` is the one this
 * rail wants: the magic-link callback demands an intent cookie the browser of
 * an agent-started sign-in has never been given, so it would redirect every
 * such human to `authError=invalid-link`.
 */
const SIGN_IN_LINK_REDIRECT_TO = AUTH_SIGN_IN_PATH

/**
 * The only public entry to an email sign-in, mirroring
 * `signupAbuse/actions:signUp`'s stance: one action, so "a sign-in was started"
 * either happened or did not.
 *
 * The record is written first because the code does not exist until
 * `auth:signIn` mints it, and the send callback binds it back by address. If
 * the library throws — bad redirect, mail refused — the row stays unbound, and
 * an unbound row is never pending, so no code and no attempt budget survive a
 * half-finished start.
 *
 * `now` is the caller's, like every other internal-key entry point, so a
 * fixture can pin it. It moves this record only; the library dates its own code
 * from the real clock.
 */
export const start = action({
  args: {
    internalKey: v.string(),
    email: v.string(),
    clientName: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<{ requestId: string; expiresIn: number }> => {
    requireApiInternalKey(args.internalKey)
    const email = canonicalSignInEmail(args.email)
    // Refuse before either side of the sign-in can persist anything: the
    // Convex Auth email provider creates its user/account/code in a mutation
    // before the delivery callback runs, and this rail's request row would
    // otherwise be written before calling that provider. Keep the response
    // shape stable for the unauthenticated enumeration firewall.
    if (isBlockedEmailDomain(email)) {
      return { requestId: generateSignInRequestId(), expiresIn: SIGN_IN_CODE_TTL_SECONDS }
    }
    const created = await ctx.runMutation(internal.domains.authRequests.mutations.create, {
      email,
      now: args.now,
      ...(args.clientName === undefined ? {} : { clientName: args.clientName }),
    })
    // Both allowed and refused addresses receive the same request handle. A
    // policy refusal leaves this record unbound and sends no email.
    await ctx.runAction(signIn, {
      provider: 'email',
      params: { email, redirectTo: SIGN_IN_LINK_REDIRECT_TO },
    })
    return created
  },
})

/**
 * What a verification came to, in Duet's own vocabulary.
 *
 * A domain result, never an HTTP status: the route maps these, and this action
 * has to stay callable — and readable — from a fixture that never boots one.
 */
export type VerifyOutcome =
  | {
      kind: 'issued'
      accessToken: string
      prefix: string
      scopes: string[]
      workspace: { slug: string; name: string }
      created: boolean
    }
  | { kind: 'ambiguous'; workspaces: SignInWorkspaceChoice[] }
  | { kind: 'forbidden' }
  | { kind: 'invalid_code'; attemptsRemaining: number }
  | { kind: 'expired' }

/**
 * What the key is called in the human's key list when the agent did not say.
 *
 * Revocation is a web page (decision 18), so the client's own name for itself
 * is most of what a person has to recognize the credential by later.
 */
const DEFAULT_SIGN_IN_KEY_NAME = 'API sign-in'

/**
 * Redeem a proved code for a human identity key and selected workspace metadata.
 *
 * **The ordering is the design.** `verifyCodeAndSignIn.js:69-75` deletes a
 * correct code the moment it looks it up, so every question whose answer the
 * caller might still have to act on — which workspace? are they even a member? —
 * is settled *before* redemption. That is possible only because the request
 * record carries the email, and it is why a `workspace_ambiguous` refusal leaves
 * the code and the record exactly as it found them.
 *
 * The guess is also checked against the code this record was born with before
 * the library ever sees it. Without that, one caller could open a request per
 * throwaway address of their own and spend each one's budget guessing at
 * somebody else's live code — five attempts multiplied by however many records
 * are cheap to create. Here a code minted for another request is simply a wrong
 * code: one attempt spent, and the real code untouched.
 */
export const verify = action({
  args: {
    internalKey: v.string(),
    requestId: v.string(),
    code: v.string(),
    name: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
    workspaceSlug: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<VerifyOutcome> => {
    requireApiInternalKey(args.internalKey)

    const pending = await ctx.runQuery(internal.domains.authRequests.queries.pendingSignIn, {
      requestId: args.requestId,
      now: args.now,
    })
    if (pending === null) return { kind: 'expired' }
    const { request, memberships } = pending

    const spendGuess = async (): Promise<VerifyOutcome> => {
      // The exhausting guess still answers `invalid_code` — the caller asked
      // about a code, and `attemptsRemaining: 0` is the honest answer — but the
      // record dies with it, so everything after it reads `expired`.
      const { attemptsRemaining } = await ctx.runMutation(
        internal.domains.authRequests.mutations.spendAttempt,
        { requestId: args.requestId, now: args.now },
      )
      return { kind: 'invalid_code', attemptsRemaining }
    }

    // FIRST, before anything that can describe the account.
    //
    // `start` is unauthenticated and tells a caller nothing — that is slice
    // 09's enumeration firewall. This is the other end of it. Resolving the
    // workspace before proving the code hands an anonymous caller who merely
    // knows an address a `409` listing every workspace slug, name and role that
    // person belongs to, and a `403`-vs-`400` membership oracle for any slug
    // they care to guess, at zero attempt cost because neither branch spends
    // one.
    //
    // The ladder's rule is that ambiguity is settled before **redemption**, and
    // it still is: redemption is the `auth:signIn` call below, which destroys
    // the code. Comparing a hash destroys nothing, so it belongs above the
    // resolution, not beside it.
    if ((await hashApiKey(args.code)) !== request.codeHash) return await spendGuess()

    const resolution = resolveSignInWorkspace({
      ...(args.workspaceSlug === undefined ? {} : { requestedSlug: args.workspaceSlug }),
      memberships,
    })
    if (resolution.kind === 'ambiguous') {
      return { kind: 'ambiguous', workspaces: memberships.map(asChoice) }
    }
    if (resolution.kind === 'forbidden') return { kind: 'forbidden' }

    const redeemed = (await ctx
      .runAction(signIn, { params: { code: args.code } })
      .catch(() => null)) as SignInResult | null
    const redeemedUserId = redeemed === null ? null : subjectOf(redeemed)
    if (redeemedUserId === null) return await spendGuess()

    // The identity the code actually authenticated, not the one the record
    // claims. Belt to the code-hash braces above: a disagreement between the
    // two halves of one sign-in has no safe reading other than "wrong code".
    const identity = await ctx.runQuery(internal.domains.authRequests.queries.redeemedIdentity, {
      userId: redeemedUserId,
    })
    if (identity === null || identity.email !== normalizeEmail(request.email)) {
      return await spendGuess()
    }
    const userId = redeemedUserId as Id<'users'>

    let workspaceId: Id<'workspaces'>
    if (resolution.kind === 'create') {
      // Only on this branch. A returning human's stored name is one
      // agent-supplied string away from being overwritten — `profileFieldsToKeep`
      // keeps a name that *was provided*, so providing one wins — and nothing
      // but this `if` stands between them and being renamed by whatever an agent
      // typed. `verify`'s own `name` outranks the one `start` recorded because
      // it is the later thing the human was asked.
      const name = args.name
      if (name !== undefined) {
        await ctx.runMutation(internal.domains.authRequests.mutations.applySignInName, {
          userId,
          email: request.email,
          name,
        })
      }
      try {
        workspaceId = (
          await completeSignUp(ctx, {
            userId,
            ...(args.workspaceName === undefined ? {} : { workspaceName: args.workspaceName }),
          })
        ).workspaceId
      } catch (error) {
        if (error instanceof SignupDomainRefusalError) return { kind: 'forbidden' }
        throw error
      }
    } else {
      const bound = memberships.find(workspace => workspace.slug === resolution.slug)
      if (bound === undefined) return { kind: 'forbidden' }
      workspaceId = bound.workspaceId
    }

    const issued = await ctx.runMutation(internal.domains.authRequests.mutations.issueSignInKey, {
      requestId: args.requestId,
      userId,
      workspaceId,
      keyName: request.clientName ?? DEFAULT_SIGN_IN_KEY_NAME,
      now: args.now,
    })
    return { kind: 'issued', ...issued, created: resolution.kind === 'create' }
  },
})

interface SignInResult {
  tokens?: { token: string; refreshToken: string } | null
}

function asChoice(membership: {
  slug: string
  name: string
  role: SignInWorkspaceChoice['role']
}): SignInWorkspaceChoice {
  return { slug: membership.slug, name: membership.name, role: membership.role }
}

/**
 * The user the freshly minted token names.
 *
 * `auth:signIn` hands back tokens and nothing else, and the `sub` claim is
 * `userId|sessionId` (`tokens.js`, `TOKEN_SUB_CLAIM_DIVIDER`). Read, never
 * trusted: the value goes straight to a query that refuses anything that is not
 * a real `users` id, and there is no signature worth re-checking on a token this
 * same request signed microseconds earlier.
 */
function subjectOf(result: SignInResult): string | null {
  const token = result.tokens?.token
  if (typeof token !== 'string') return null
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const claims = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) as {
      sub?: unknown
    }
    if (typeof claims.sub !== 'string') return null
    return claims.sub.split('|')[0] ?? null
  } catch {
    return null
  }
}
