import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  BLOCKED_MX_BACKENDS,
  DISPOSABLE_EMAIL_DOMAINS,
  SHARED_MAILBOX_PROVIDERS,
  SPAM_EMAIL_DOMAINS,
} from '../convex/domains/signupAbuse/blockedEmailDomains'
import {
  collectEvidence,
  MAX_REQUEST_AGE_MS,
  type SignupEvidence,
} from '../convex/domains/signupAbuse/evidence'
import {
  decideSignup,
  DOMAIN_SIGNUP_VELOCITY_LIMIT,
  type SignupReason,
} from '../convex/domains/signupAbuse/policy'

const domainFixtures: Array<[string[], string[]]> = [
  [DISPOSABLE_EMAIL_DOMAINS, ['mailinator.com']],
  [SPAM_EMAIL_DOMAINS, ['outlook.com']],
  [BLOCKED_MX_BACKENDS, ['gravityengine.cc']],
  [SHARED_MAILBOX_PROVIDERS, ['gmail.com']],
]
const originalDomains = domainFixtures.map(([domains]) => domains.slice())
beforeEach(() => {
  for (const [domains, fixtures] of domainFixtures) domains.splice(0, domains.length, ...fixtures)
})
afterEach(() => {
  for (const [index, [domains]] of domainFixtures.entries()) {
    domains.splice(0, domains.length, ...originalDomains[index]!)
  }
})

const NOW = 1_770_000_000_000
const DEVICE = { visitorId: 'visitor-a', requestId: 'request-a' }
const CLEAN_EMAIL = 'someone@example.com'

function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown; throws?: boolean }>,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment))
    if (match === undefined) throw new Error(`unrouted fetch: ${url}`)
    const [, route] = match
    if (route.throws === true) throw new Error('network down')
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
    } as Response
  }) as typeof globalThis.fetch
}

function fingerprintEvent(options: {
  visitorId?: string
  timestamp?: number
  bot?: string
}): unknown {
  return {
    products: {
      identification: {
        data: {
          ...(options.visitorId === undefined ? {} : { visitorId: options.visitorId }),
          ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
        },
      },
      ...(options.bot === undefined ? {} : { botd: { data: { bot: { result: options.bot } } } }),
    },
  }
}

const CLEAN_MX = { Answer: [{ data: '10 alt1.gmail-smtp-in.l.google.com.' }] }

describe('signup verdict', () => {
  test('denies a requestId that resolves to a different visitor than the client claimed', () => {
    // The only thing stopping a farmer from replaying one clean identification
    // across many signups. Proof of tampering, so it outranks staleness below.
    const evidence: SignupEvidence = {
      claimed: DEVICE,
      resolvedVisitorId: 'someone-else',
      eventTimestamp: NOW,
    }

    expect(decideSignup(evidence, CLEAN_EMAIL, NOW)).toEqual({
      verdict: 'no_grant',
      reason: 'forgery-mismatch',
    })
  })

  test('denies a confirmed bot', () => {
    const evidence: SignupEvidence = {
      claimed: DEVICE,
      resolvedVisitorId: DEVICE.visitorId,
      eventTimestamp: NOW,
      botResult: 'bad',
    }

    expect(decideSignup(evidence, CLEAN_EMAIL, NOW).verdict).toBe('no_grant')
  })

  test('allows a clean signup and reports the VERIFIED visitor, not the claimed one', () => {
    // Slice 04 counts devices off this field. If it ever carried the claimed
    // value, a farmer could pick their own device id and never collide.
    const evidence: SignupEvidence = {
      claimed: DEVICE,
      resolvedVisitorId: DEVICE.visitorId,
      eventTimestamp: NOW,
      botResult: 'notDetected',
    }

    expect(decideSignup(evidence, CLEAN_EMAIL, NOW)).toEqual({
      verdict: 'allow',
      reason: 'clean',
      verifiedVisitorId: DEVICE.visitorId,
    })
  })

  test.each([
    ['no-device' as const],
    ['no-api-key' as const],
    ['api-error' as const],
    ['event-not-found' as const],
  ])('fails open when device evidence is unavailable (%s)', unavailable => {
    // Deliberate: denying real users on a network hiccup costs more than the
    // trials a farmer saves by blocking the identification script.
    const decision = decideSignup(
      { claimed: DEVICE, deviceUnavailable: unavailable },
      CLEAN_EMAIL,
      NOW,
    )

    expect(decision.verdict).toBe('allow')
    expect(decision.reason).toBe(unavailable)
    expect(decision.verifiedVisitorId).toBeUndefined()
  })

  test('fails open on a stale requestId and refuses to report its visitor', () => {
    const evidence: SignupEvidence = {
      claimed: DEVICE,
      resolvedVisitorId: DEVICE.visitorId,
      eventTimestamp: NOW - MAX_REQUEST_AGE_MS - 1,
    }

    expect(decideSignup(evidence, CLEAN_EMAIL, NOW)).toEqual({
      verdict: 'allow',
      reason: 'stale-request',
    })
  })

  test('a forged requestId is denied even once it is stale', () => {
    // Staleness is uncertainty; a visitor mismatch is proof. Proof does not
    // expire, or replaying an old event would become the cheapest bypass.
    const evidence: SignupEvidence = {
      claimed: DEVICE,
      resolvedVisitorId: 'someone-else',
      eventTimestamp: NOW - MAX_REQUEST_AGE_MS - 1,
    }

    expect(decideSignup(evidence, CLEAN_EMAIL, NOW).verdict).toBe('no_grant')
  })
})

describe('email-shaped withholds', () => {
  const verified: SignupEvidence = {
    claimed: DEVICE,
    resolvedVisitorId: DEVICE.visitorId,
    eventTimestamp: NOW,
    botResult: 'notDetected',
  }

  test.each([
    ['a disposable provider', 'someone@mailinator.com', 'blocked-email-domain' as const],
    ['a curated spam domain', 'someone@outlook.com', 'blocked-email-domain' as const],
    ['a subdomain address', 'someone@web.acme.co.uk', 'email-subdomain' as const],
  ])('withholds the trial for %s', (_label: string, email: string, reason: SignupReason) => {
    expect(decideSignup(verified, email, NOW)).toEqual({ verdict: 'no_grant', reason })
  })

  test('withholds from a vanity domain whose MX delegates to a disposable backend', () => {
    // The signal that caught the largest cluster on chat-app: throwaway vanity
    // domains sail past the address blocklist, but their MX points at a tiny
    // set of providers no real business uses.
    expect(
      decideSignup(
        { ...verified, mx: { kind: 'records', hosts: ['mx1.gravityengine.cc'] } },
        'someone@fresh-vanity.example',
        NOW,
      ).reason,
    ).toBe('suspicious-email-mx')
  })

  test('withholds from a domain that publishes no usable mail host', () => {
    expect(
      decideSignup({ ...verified, mx: { kind: 'none' } }, 'someone@nomail.example', NOW).reason,
    ).toBe('suspicious-email-mx')
  })

  test('a DNS failure never costs a real domain its trial', () => {
    // Fail open on our own network trouble, exactly as with device evidence.
    expect(
      decideSignup({ ...verified, mx: { kind: 'error' } }, 'someone@acme.com', NOW).verdict,
    ).toBe('allow')
  })

  test.each([
    ['a bare ccTLD address', 'someone@acme.co.uk'],
    ['an ordinary address', 'someone@acme.com'],
  ])('allows %s', (_label, email) => {
    // The public-suffix table is what keeps `acme.co.uk` from reading as a
    // subdomain of `co.uk`; without it every UK signup would be denied.
    expect(
      decideSignup({ ...verified, mx: { kind: 'records', hosts: ['mx.acme.com'] } }, email, NOW)
        .verdict,
    ).toBe('allow')
  })

  test('email rules apply even when the device could not be identified', () => {
    // Otherwise blocking the identification script would also buy an escape
    // from the blocklists, which is the cheapest bypass in the system.
    expect(
      decideSignup({ deviceUnavailable: 'no-device' }, 'someone@mailinator.com', NOW).verdict,
    ).toBe('no_grant')
  })

  test('withholds from a vanity domain minting accounts faster than people sign up', () => {
    // The farm that took 154 VMs on 2026-09-02/03: one Hostinger-hosted vanity
    // domain, an account a minute for half an hour, every one without device
    // evidence. Nothing about the fifth account distinguishes it from the
    // first — the rate is the only signal, so the rate is the rule.
    const farm = {
      deviceUnavailable: 'no-device' as const,
      domainSignupsLastDay: DOMAIN_SIGNUP_VELOCITY_LIMIT,
    }
    expect(decideSignup(farm, 'duet3ke9a5tn4h@satucrm.example', NOW)).toEqual({
      verdict: 'no_grant',
      reason: 'domain-velocity',
    })
    expect(
      decideSignup(
        { ...farm, domainSignupsLastDay: DOMAIN_SIGNUP_VELOCITY_LIMIT - 1 },
        'duet3ke9a5tn4h@satucrm.example',
        NOW,
      ).verdict,
    ).toBe('allow')
  })

  test('a shared mailbox provider is never rate-limited', () => {
    // Fifty Gmail signups in an hour is a good day, not a farm: the rate only
    // means something for a domain one party controls.
    expect(
      decideSignup(
        { ...verified, domainSignupsLastDay: DOMAIN_SIGNUP_VELOCITY_LIMIT + 1 },
        'someone@gmail.com',
        NOW,
      ).verdict,
    ).toBe('allow')
  })
})

describe('signup evidence', () => {
  test('resolves an identification event and the domain MX together', async () => {
    const evidence = await collectEvidence(
      { email: 'someone@gmail.com', device: DEVICE },
      {
        fetch: fakeFetch({
          'api.fpjs.io': {
            body: fingerprintEvent({
              visitorId: DEVICE.visitorId,
              timestamp: NOW,
              bot: 'notDetected',
            }),
          },
          'dns-query': { body: CLEAN_MX },
        }),
        now: NOW,
        apiKey: 'key',
      },
    )

    expect(evidence.resolvedVisitorId).toBe(DEVICE.visitorId)
    expect(evidence.botResult).toBe('notDetected')
    expect(evidence.mx).toEqual({ kind: 'records', hosts: ['alt1.gmail-smtp-in.l.google.com'] })
    expect(evidence.deviceUnavailable).toBeUndefined()
  })

  test.each([
    ['a transport failure', { throws: true }, 'api-error'],
    ['a 500', { status: 500 }, 'api-error'],
    ['an unknown requestId', { status: 404 }, 'event-not-found'],
    ['an event with no identification', { body: { products: {} } }, 'event-not-found'],
  ])('reports %s as unavailable rather than throwing', async (_label, route, expected) => {
    const evidence = await collectEvidence(
      { email: 'someone@gmail.com', device: DEVICE },
      {
        fetch: fakeFetch({ 'api.fpjs.io': route, 'dns-query': { body: CLEAN_MX } }),
        now: NOW,
        apiKey: 'key',
      },
    )

    expect(evidence.deviceUnavailable).toBe(expected as SignupEvidence['deviceUnavailable'])
    expect(decideSignup(evidence, CLEAN_EMAIL, NOW).verdict).toBe('allow')
  })

  test('reports no-api-key without calling Fingerprint at all', async () => {
    const evidence = await collectEvidence(
      { email: 'someone@gmail.com', device: DEVICE },
      { fetch: fakeFetch({ 'dns-query': { body: CLEAN_MX } }), now: NOW },
    )

    expect(evidence.deviceUnavailable).toBe('no-api-key')
  })

  test('strips MX preference numbers and the trailing root dot', async () => {
    // The blocklist in slice 05 matches on registrable domains, so a stray
    // "10 " prefix or trailing dot would silently stop every rule matching.
    const evidence = await collectEvidence(
      { email: 'someone@vanity.example', device: undefined },
      {
        fetch: fakeFetch({
          'dns-query': {
            body: { Answer: [{ data: '5 MX1.Gravityengine.CC.' }, { data: '10 mx2.other.net.' }] },
          },
        }),
        now: NOW,
      },
    )

    expect(evidence.mx).toEqual({
      kind: 'records',
      hosts: ['mx1.gravityengine.cc', 'mx2.other.net'],
    })
  })

  test('an empty MX answer is reported as no usable mail host, not as unknown', async () => {
    // Distinguishable on purpose: slice 05 treats "publishes no mail host" as
    // suspicious, but must never punish a domain for a DNS hiccup.
    const evidence = await collectEvidence(
      { email: 'someone@nomail.example', device: undefined },
      { fetch: fakeFetch({ 'dns-query': { body: {} } }), now: NOW },
    )

    expect(evidence.mx).toEqual({ kind: 'none' })
  })

  test('a DNS failure is unknown, not "no mail host"', async () => {
    const evidence = await collectEvidence(
      { email: 'someone@flaky.example', device: undefined },
      { fetch: fakeFetch({ 'dns-query': { throws: true } }), now: NOW },
    )

    expect(evidence.mx).toEqual({ kind: 'error' })
  })
})
