import { describe, expect, test } from 'bun:test'

import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  cleanDisplayName,
  normalizeEmail,
} from '../convex/domains/users/identity'
import { profileFieldsToKeep } from '../convex/domains/users/model'

describe('email normalization', () => {
  test('preserves plus tags for providers where aliases are distinct addresses', () => {
    expect(normalizeEmail('  Duet.Tests+staging-e2e-123@agentmail.to  ')).toBe(
      'duet.tests+staging-e2e-123@agentmail.to',
    )
  })

  test('canonicalizes Gmail and Googlemail aliases', () => {
    expect(normalizeEmail('Du.et.Tests+launch@googlemail.com')).toBe('duettests@gmail.com')
  })

  test('rejects canonical identities beyond the global storage bounds', () => {
    expect(() =>
      normalizeEmail(`${'e'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length + 1)}@example.com`),
    ).toThrow(`Email must be at most ${MAX_EMAIL_LENGTH} characters`)
    expect(() => cleanDisplayName('n'.repeat(MAX_DISPLAY_NAME_LENGTH + 1))).toThrow(
      `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    )
    expect(
      normalizeEmail(`${'e'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length)}@example.com`),
    ).toHaveLength(MAX_EMAIL_LENGTH)
    expect(cleanDisplayName(` ${'n'.repeat(MAX_DISPLAY_NAME_LENGTH)} `)).toHaveLength(
      MAX_DISPLAY_NAME_LENGTH,
    )
  })
})

/* A returning sign-in used to patch `name`, `image`, `firstName` and `lastName`
   unconditionally, so signing in with Google and then once by email erased the
   avatar and the display name Google had supplied. Absent is not empty. */
describe('what a returning sign-in may overwrite', () => {
  /* Keys, not values. `toEqual` treats a present-but-`undefined` key as absent,
     and Convex's `patch` does the exact opposite — an explicit `undefined` is
     how you *delete* a field. So the assertion that matches the semantics is
     which keys exist, and asserting on values here cannot fail on the bug. */
  test('a provider that carries nothing writes no key at all', () => {
    expect(Object.keys(profileFieldsToKeep({}))).toEqual([])
  })

  test('a provider that carries a field still wins', () => {
    const patch = profileFieldsToKeep({ name: 'Ada Lovelace', image: 'https://example.test/a.png' })
    expect(Object.keys(patch).sort()).toEqual(['image', 'name'])
    expect(patch).toEqual({ name: 'Ada Lovelace', image: 'https://example.test/a.png' })
  })

  test('each field is decided on its own', () => {
    // A provider with a name and no avatar must not carry an `image` key, or
    // the patch deletes an avatar an earlier provider stored.
    const patch = profileFieldsToKeep({ name: 'Ada', firstName: 'Ada' })
    expect(Object.keys(patch).sort()).toEqual(['firstName', 'name'])
  })
})
