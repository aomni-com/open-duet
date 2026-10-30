// The one verdict owner. Pure: no ctx, no fetch, no clock — `now` is passed in.
//
// Fingerprint, the email blocklists (slice 05) and the device count (slice 04)
// all feed this function. None of them owns its own `blocked` boolean, because
// two sources of "is this signup ok" is how a gate ends up disagreeing with
// itself.

import {
  hasEmailSubdomain,
  isBlockedEmailDomain,
  isSharedMailboxProvider,
  isSuspiciousEmailDomainMx,
} from './blockedEmailDomains'
import { isStale, type SignupEvidence } from './evidence'

/**
 * Prior accounts on one controlled domain inside a day before the next one
 * is refused. Five is above any team signing up together in a workshop that
 * we have seen, and far below a farm's one-a-minute.
 */
export const DOMAIN_SIGNUP_VELOCITY_LIMIT = 5
/** The day the limit is measured over; the count is taken by `signupContext`. */
export const DOMAIN_SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Device and uncertain email objections withhold the trial. Blocked email
 * domains and controlled-domain velocity reject before workspace bootstrap.
 *
 * A paused workspace never provisions a VM, so this costs nothing to hand out —
 * The hard refusal avoids creating another spam account row.
 */
export type SignupVerdict = 'allow' | 'no_grant'

export type SignupReason =
  // withheld or refused by completeSignUp
  | 'forgery-mismatch'
  | 'botd-bad'
  | 'blocked-email-domain'
  | 'suspicious-email-mx'
  | 'email-subdomain'
  | 'domain-velocity'
  // allow
  | 'clean'
  | 'no-device'
  | 'no-api-key'
  | 'api-error'
  | 'event-not-found'
  | 'stale-request'

export type SignupDecision = {
  verdict: SignupVerdict
  reason: SignupReason
  /** Only set when the event verified; slice 04 counts on this, never on the claim. */
  verifiedVisitorId?: string
}

/**
 * Conservative by construction. Every rule below is either binary (a visitor
 * mismatch, a confirmed bot, a listed domain) or high-confidence by evidence (an
 * MX delegating to a known disposable backend). There is no suspect-score band,
 * no VPN / incognito / virtual-machine / tampering / devtools tier, and no
 * vendor velocity product — every one of those is a tuned threshold, and the
 * thresholds that exist were tuned against a different product's traffic. Do
 * not add them back without evidence from this product.
 *
 * The one rate rule here IS evidence from this product: on 2026-09-02/03 a
 * single vanity domain minted 163 accounts in four half-hour bursts, one a
 * minute, each without device evidence, and 154 of them held a VM. Per account
 * every rule above passed; the rate was the only thing that could have said no.
 *
 * `email` is required, not optional: three of the rules read it, and an optional
 * parameter is how a caller ends up silently skipping them.
 */
export function decideSignup(evidence: SignupEvidence, email: string, now: number): SignupDecision {
  // Email-shaped denials first: they need no device evidence, so a farmer who
  // blocks the identification script does not escape these too.
  if (isBlockedEmailDomain(email)) {
    return { verdict: 'no_grant', reason: 'blocked-email-domain' }
  }
  if (evidence.mx !== undefined && isSuspiciousEmailDomainMx(evidence.mx)) {
    return { verdict: 'no_grant', reason: 'suspicious-email-mx' }
  }
  if (hasEmailSubdomain(email)) {
    return { verdict: 'no_grant', reason: 'email-subdomain' }
  }
  // A domain one party controls, minting accounts faster than a team signs up.
  // Shared providers are exempt: fifty Gmail signups in a day is a good day.
  if (
    !isSharedMailboxProvider(email) &&
    evidence.domainSignupsLastDay !== undefined &&
    evidence.domainSignupsLastDay >= DOMAIN_SIGNUP_VELOCITY_LIMIT
  ) {
    return { verdict: 'no_grant', reason: 'domain-velocity' }
  }

  // Forgery outranks staleness: a resolved visitorId that does not match the
  // claim is proof of a replayed or swapped requestId, and proof of tampering
  // does not expire.
  if (
    evidence.resolvedVisitorId !== undefined &&
    evidence.claimed !== undefined &&
    evidence.resolvedVisitorId !== evidence.claimed.visitorId
  ) {
    return { verdict: 'no_grant', reason: 'forgery-mismatch' }
  }

  // Missing evidence is uncertainty, not innocence — but it allows. See the
  // fail-open note in `evidence.ts`; that comment is the lever.
  if (evidence.deviceUnavailable !== undefined) {
    return { verdict: 'allow', reason: evidence.deviceUnavailable }
  }

  // A stale requestId is a replay we cannot corroborate. Fail open, and do not
  // report a verified visitor for it — slice 04 must not count a stale claim.
  if (isStale(evidence, now)) return { verdict: 'allow', reason: 'stale-request' }

  if (evidence.botResult === 'bad') return { verdict: 'no_grant', reason: 'botd-bad' }

  return {
    verdict: 'allow',
    reason: 'clean',
    ...(evidence.resolvedVisitorId === undefined
      ? {}
      : { verifiedVisitorId: evidence.resolvedVisitorId }),
  }
}
