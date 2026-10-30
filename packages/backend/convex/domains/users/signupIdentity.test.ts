import { describe, expect, test } from 'bun:test'

import { canonicalEmail, classifySignupIdentity } from './signupIdentity'

describe('signup identity', () => {
  test.each([
    ['a.l.i.c.e+x@gmail.com', 'alice@gmail.com'],
    ['bob+x@outlook.com', 'bob@outlook.com'],
    ['b.o.b@outlook.com', 'b.o.b@outlook.com'],
    [' A.L.I.C.E+x@googlemail.com ', 'alice@gmail.com'],
    [' +tag@gmail.com ', '+tag@gmail.com'],
    [' NotAnEmail ', 'notanemail'],
  ])('canonicalizes %s as %s', (raw, canonical) => {
    expect(canonicalEmail(raw)).toBe(canonical)
  })

  test('preserves distinct grant keys for aliases of a configured test inbox', () => {
    const env = { DUET_SIGNUP_TEST_IDENTITIES: ' , inbox@example.com, ' }

    const runA = classifySignupIdentity('inbox+staging-e2e-runA@example.com', env)
    const runB = classifySignupIdentity('inbox+staging-e2e-runB@example.com', env)

    expect(runA).toEqual({
      canonicalEmail: 'inbox@example.com',
      testIdentity: true,
      disposable: true,
      grantKey: 'inbox+staging-e2e-runa@example.com',
    })
    expect(runB).toEqual({
      canonicalEmail: 'inbox@example.com',
      testIdentity: true,
      disposable: true,
      grantKey: 'inbox+staging-e2e-runb@example.com',
    })
    expect(runA.grantKey).not.toBe(runB.grantKey)
  })

  test('an address on a configured inbox WITHOUT the synthetic marker is not exempt', () => {
    // This is what leaves the abuse journey a deliverable address the gate is
    // willing to refuse. Exempting the whole inbox would leave nothing to prove
    // the gate works with.
    const env = { DUET_SIGNUP_TEST_IDENTITIES: 'inbox@example.com' }

    expect(classifySignupIdentity('inbox+abuse-run1@example.com', env)).toEqual({
      canonicalEmail: 'inbox@example.com',
      testIdentity: false,
      // Refused the trial, but still OURS: every address that delivers to the
      // e2e mailbox is disposable, marker or not.
      disposable: true,
      grantKey: 'inbox@example.com',
    })
  })

  test('the synthetic marker alone does not exempt an unconfigured inbox', () => {
    // Otherwise anyone could exempt themselves by putting the marker in their
    // own address.
    expect(
      classifySignupIdentity('attacker+staging-e2e-x@evil.example', {
        DUET_SIGNUP_TEST_IDENTITIES: 'inbox@example.com',
      }).testIdentity,
    ).toBe(false)
  })

  test('uses the canonical email as the grant key for a non-test identity', () => {
    expect(
      classifySignupIdentity('person+alias@example.com', {
        DUET_SIGNUP_TEST_IDENTITIES: 'someone-else@example.com',
      }),
    ).toEqual({
      canonicalEmail: 'person@example.com',
      testIdentity: false,
      disposable: false,
      grantKey: 'person@example.com',
    })
  })

  test('classifies no address as a test identity when the list is unset', () => {
    expect(classifySignupIdentity('inbox+staging-e2e-run@example.com', {}).testIdentity).toBe(false)
  })

  // Trial exemption and disposability are DIFFERENT questions, and conflating
  // them is what left the abuse journey's accounts immortal: its address is
  // deliberately not exempt, so a marker-keyed rule never reclaimed it.
  // Exemption needs inbox AND marker; disposability needs only the inbox.
  test('every address on a configured inbox is disposable, exempt or not', () => {
    const env = { DUET_SIGNUP_TEST_IDENTITIES: 'inbox@example.com' }

    expect(classifySignupIdentity('inbox+staging-e2e-run@example.com', env).disposable).toBe(true)
    expect(classifySignupIdentity('inbox+abuse-run@example.com', env).disposable).toBe(true)
    expect(classifySignupIdentity('inbox@example.com', env).disposable).toBe(true)
  })

  test('a stranger is never disposable, marker or not', () => {
    const env = { DUET_SIGNUP_TEST_IDENTITIES: 'inbox@example.com' }

    expect(classifySignupIdentity('person@example.com', env).disposable).toBe(false)
    // The marker is not self-service: it cannot make a stranger's account
    // disposable any more than it can exempt them.
    expect(classifySignupIdentity('attacker+staging-e2e-x@evil.example', env).disposable).toBe(
      false,
    )
  })

  test('nothing is disposable when no test inbox is configured', () => {
    // Production never sets DUET_SIGNUP_TEST_IDENTITIES, so this rule is inert
    // there — no real signup can ever be born with an expiry.
    expect(classifySignupIdentity('inbox+staging-e2e-run@example.com', {}).disposable).toBe(false)
  })
})
