import type { Env } from '../../config'

export type SignupIdentity = {
  canonicalEmail: string
  testIdentity: boolean
  /**
   * The address belongs to a configured test inbox, so the account is ours and
   * is safe to delete on a timer. Deliberately WIDER than `testIdentity`:
   * exemption from the trial gate needs the synthetic marker too, disposability
   * does not. The abuse journey's deny leg is the case that forces the split —
   * it must stay un-exempt to have something for the gate to refuse, while
   * still being an account we own and must reclaim.
   */
  disposable: boolean
  grantKey: string
}

export function canonicalEmail(raw: string): string {
  const trimmed = raw.trim()
  const normalized = trimmed.toLowerCase()
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at === normalized.length - 1) return normalized

  const originalLocal = normalized.slice(0, at)
  const originalDomain = normalized.slice(at + 1)
  const domain = originalDomain === 'googlemail.com' ? 'gmail.com' : originalDomain
  const untaggedLocal = originalLocal.split('+')[0] ?? ''
  const local = domain === 'gmail.com' ? untaggedLocal.replaceAll('.', '') : untaggedLocal

  return local ? `${local}@${domain}` : normalized
}

/**
 * The marker every live-acceptance run already puts in its address
 * (`taggedInboxAddress` builds `<inbox>+staging-e2e-<journey>-<id>@…`). Reused
 * rather than reinvented: `testing/stagingE2e.ts` uses the same string to decide
 * what counts as a synthetic identity.
 */
const SYNTHETIC_EMAIL_MARKER = 'staging-e2e-'

/**
 * A test identity must match a configured inbox AND carry the synthetic marker.
 *
 * Requiring both is what lets ONE mailbox serve the live journeys and the
 * abuse journey's deny leg: `inbox+staging-e2e-x@` is exempt and
 * `inbox+abuse-x@` is not, while both deliver to the same place. Exempting the
 * whole inbox instead would leave no deliverable address that the gate is
 * willing to refuse, and there would be nothing to prove the gate works.
 */
export function classifySignupIdentity(email: string, env: Env = process.env): SignupIdentity {
  const normalized = email.trim().toLowerCase()
  const canonical = canonicalEmail(email)
  const configuredIdentities = (env.DUET_SIGNUP_TEST_IDENTITIES ?? '')
    .split(',')
    .map(identity => identity.trim())
    .filter(identity => identity.length > 0)
    .map(canonicalEmail)
  const disposable = configuredIdentities.includes(canonical)
  const testIdentity = disposable && normalized.includes(SYNTHETIC_EMAIL_MARKER)

  return {
    canonicalEmail: canonical,
    testIdentity,
    disposable,
    grantKey: testIdentity ? normalized : canonical,
  }
}
