// Deliberately NOT `'use node'`. Slice 00 proved the Fingerprint REST API and
// DNS-over-HTTPS are both reachable from Convex's default isolate, so the gate
// needs neither the Fingerprint server SDK nor `node:dns`.

import { getAuthUserId } from '@convex-dev/auth/server'
import { v } from 'convex/values'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import { action, type ActionCtx } from '../../_generated/server'
import { signupMxLookupEnabled } from '../../config'
import { classifySignupIdentity } from '../users/signupIdentity'
import { collectEvidence } from './evidence'
import { decideSignup } from './policy'

export class SignupDomainRefusalError extends Error {
  constructor() {
    super('Signup is not allowed for this email domain')
    this.name = 'SignupDomainRefusalError'
  }
}

/**
 * The only public entry to workspace creation.
 *
 * `bootstrap` used to be a public mutation, which meant any signed-in browser
 * could call it from the console — so a verdict passed *into* it as an argument
 * would have been trivially forgeable. Verification therefore has to happen on
 * this side of the seam, with the mutation reachable only from here.
 *
 * `device` is optional on purpose: a client that cannot identify (adblocker,
 * offline, no key) must still be able to sign up. See the fail-open note in
 * `evidence.ts` — that is a deliberate, tunable lever, not an oversight.
 */
export const signUp = action({
  args: {
    tokens: v.optional(
      v.object({
        invite: v.optional(v.string()),
        acquisition: v.optional(v.string()),
      }),
    ),
    device: v.optional(v.object({ visitorId: v.string(), requestId: v.string() })),
    // Carried straight through to `bootstrapUser`, which owns the birth name.
    // This action writes no profile of its own: its job is the abuse verdict
    // plus bootstrap, so an account's `name` is settled by whoever created the
    // account before it ever gets here.
    workspaceName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ workspaceId: Id<'workspaces'>; workspaceSlug: string; invited: boolean }> => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) throw new Error('Unauthenticated')
    return await completeSignUp(ctx, { userId: userId as Id<'users'>, ...args })
  },
})

/**
 * The gate plus bootstrap, for an identity somebody else already established.
 *
 * `signUp` above resolves it from `ctx.auth`, which is the browser's answer;
 * `domains/authRequests/actions:verify` resolves it from a code it just redeemed
 * inside Convex, where there is no authenticated caller to read. Both arrive
 * here so the abuse verdict has one owner — an agent-rail signup faces the same
 * email and device rules as a browser one, which is what "the full trial, same
 * as a browser signup" means in the decision ledger.
 */
export async function completeSignUp(
  ctx: ActionCtx,
  args: {
    userId: Id<'users'>
    tokens?: { invite?: string; acquisition?: string }
    device?: { visitorId: string; requestId: string }
    workspaceName?: string
  },
): Promise<{ workspaceId: Id<'workspaces'>; workspaceSlug: string; invited: boolean }> {
  const { userId } = args

  const context = await ctx.runQuery(internal.domains.signupAbuse.queries.signupContext, {
    userId,
  })

  // ONE classification drives everything. A configured test identity skips
  // verification, the email rules AND the device count — not just the count —
  // so the live-acceptance journeys cannot be broken by a change to any of
  // them, and there is no per-rule exemption branch to keep in sync.
  const exempt = classifySignupIdentity(context.email).testIdentity

  // Only cold signups are evaluated. An existing member is signing in, and
  // re-verifying them would mean a device that legitimately hosts several
  // accounts starts failing their logins.
  const invited = args.tokens?.invite !== undefined
  if (!context.alreadyOnboarded && !exempt && !invited) {
    const evidence = await collectEvidence(
      { email: context.email, ...(args.device === undefined ? {} : { device: args.device }) },
      {
        fetch: (input, init) => fetch(input, init),
        now: Date.now(),
        ...(process.env.FINGERPRINT_API_KEY === undefined
          ? {}
          : { apiKey: process.env.FINGERPRINT_API_KEY }),
        mxLookup: signupMxLookupEnabled(),
      },
    )
    const decision = decideSignup(
      { ...evidence, domainSignupsLastDay: context.domainSignupsLastDay },
      context.email,
      Date.now(),
    )
    if (decision.verdict === 'no_grant') {
      if (decision.reason === 'domain-velocity' || decision.reason === 'blocked-email-domain') {
        throw new SignupDomainRefusalError()
      }
      // Other abuse objections still create the account with its trial withheld.
      await ctx.runMutation(internal.domains.signupAbuse.mutations.withholdTrialForSignup, {
        userId,
        email: context.email,
        reason: decision.reason,
        ...(decision.verifiedVisitorId === undefined
          ? {}
          : { visitorId: decision.verifiedVisitorId }),
      })
    } else if (decision.verifiedVisitorId !== undefined) {
      // Only a VERIFIED visitor counts, and only a signup we did not already
      // object to — an unverifiable one is not counted at all, so fail-open
      // extends to the count.
      await ctx.runMutation(internal.domains.signupAbuse.mutations.claimDevice, {
        userId,
        visitorId: decision.verifiedVisitorId,
      })
    }
  }

  return await ctx.runMutation(internal.domains.invitations.mutations.bootstrap, {
    userId,
    ...(args.tokens === undefined ? {} : { tokens: args.tokens }),
    ...(args.workspaceName === undefined ? {} : { workspaceName: args.workspaceName }),
  })
}
