import { describe, expect, test } from 'bun:test'

import { toJSONSchema } from 'zod'

// Imported before `./index`, and first of the two on purpose: the package
// barrel reaches `workspaces` before `auth`, which is the module order that a
// cycle between them fails on. Every consumer outside this package enters here.
import * as contract from '../index'
import {
  EmailSignInErrorSchema,
  EmailSignInStartRequestSchema,
  EmailSignInStartResponseSchema,
  EmailSignInVerifyRequestSchema,
  EmailSignInVerifyResponseSchema,
  resolveSignInWorkspace,
  type SignInWorkspaceChoice,
} from './index'

const REQUEST_ID = `req_${'a1b2c3d4'.repeat(4)}`
const CODE = 'RNP4-4Y37'

const acme: SignInWorkspaceChoice = { slug: 'acme', name: 'Acme', role: 'owner' }
const beta: SignInWorkspaceChoice = { slug: 'beta', name: 'Beta', role: 'editor' }

describe('resolveSignInWorkspace', () => {
  test('binds a requested slug the caller is a member of', () => {
    expect(resolveSignInWorkspace({ requestedSlug: 'beta', memberships: [acme, beta] })).toEqual({
      kind: 'bind',
      slug: 'beta',
    })
  })

  test('forbids a requested slug the caller is not a member of', () => {
    expect(resolveSignInWorkspace({ requestedSlug: 'other', memberships: [acme, beta] })).toEqual({
      kind: 'forbidden',
    })
  })

  test('forbids a requested slug when the caller is a member of nothing', () => {
    // Never "create the workspace they asked for": the slug they named may be
    // someone else's, and this call is unauthenticated until the code redeems.
    expect(resolveSignInWorkspace({ requestedSlug: 'acme', memberships: [] })).toEqual({
      kind: 'forbidden',
    })
  })

  test('creates when there is no live membership at all', () => {
    // Two populations arrive here: a brand-new account, and a returning human
    // whose every workspace was archived. Neither has anything to bind.
    expect(resolveSignInWorkspace({ memberships: [] })).toEqual({ kind: 'create' })
  })

  test('binds the only membership', () => {
    expect(resolveSignInWorkspace({ memberships: [acme] })).toEqual({ kind: 'bind', slug: 'acme' })
  })

  test('reports ambiguity, carrying the choices the caller must pick from', () => {
    expect(resolveSignInWorkspace({ memberships: [acme, beta] })).toEqual({
      kind: 'ambiguous',
      workspaces: [acme, beta],
    })
  })

  test('a requested slug outranks ambiguity', () => {
    // The whole point of the second call: the agent answers a 409 with a slug.
    expect(resolveSignInWorkspace({ requestedSlug: 'acme', memberships: [acme, beta] })).toEqual({
      kind: 'bind',
      slug: 'acme',
    })
  })
})

describe('email sign-in wire schemas', () => {
  test('start normalizes the email it will mail and key a rate limit on', () => {
    // Two humans typing the same address with different padding and case are
    // one human, both to the per-email bucket and to the account lookup.
    const parsed = EmailSignInStartRequestSchema.parse({ email: '  Casey@Example.COM ' })
    expect(parsed.email).toBe('casey@example.com')
    expect(parsed.client_name).toBeUndefined()
  })

  test('start rejects what is not an address, after normalizing', () => {
    expect(EmailSignInStartRequestSchema.safeParse({ email: '  casey  ' }).success).toBe(false)
    expect(EmailSignInStartRequestSchema.safeParse({ email: '' }).success).toBe(false)
  })

  test('start trims the client name and refuses one that is only padding', () => {
    const parsed = EmailSignInStartRequestSchema.parse({
      email: 'casey@example.com',
      client_name: ' Claude Code ',
    })
    expect(parsed.client_name).toBe('Claude Code')
    expect(
      EmailSignInStartRequestSchema.safeParse({ email: 'casey@example.com', client_name: '   ' })
        .success,
    ).toBe(false)
    expect(
      EmailSignInStartRequestSchema.safeParse({
        email: 'casey@example.com',
        client_name: 'x'.repeat(65),
      }).success,
    ).toBe(false)
  })

  test('the request id start hands out is the one verify accepts', () => {
    expect(
      EmailSignInStartResponseSchema.parse({ request_id: REQUEST_ID, expires_in: 600 }),
    ).toEqual({ request_id: REQUEST_ID, expires_in: 600 })
    expect(
      EmailSignInVerifyRequestSchema.safeParse({ request_id: REQUEST_ID, code: CODE }).success,
    ).toBe(true)
    // Hex, lowercase, exactly 32 — a bare id, an uppercase one, or the wrong
    // length is not a request this rail ever minted.
    for (const wrong of ['a1b2c3d4'.repeat(4), `req_${'A1B2C3D4'.repeat(4)}`, 'req_a1b2c3d4'])
      expect(
        EmailSignInVerifyRequestSchema.safeParse({ request_id: wrong, code: CODE }).success,
      ).toBe(false)
  })

  test('verify judges the code by the one human-entry grammar', () => {
    // The 32-hex token Convex Auth minted before a human had to read one back.
    expect(
      EmailSignInVerifyRequestSchema.safeParse({ request_id: REQUEST_ID, code: 'c'.repeat(32) })
        .success,
    ).toBe(false)
    // Case is normalized, not judged. A human who typed what they read in
    // lowercase made no mistake worth a 400 — the device rail has always
    // upper-cased the identical grammar — so this parses, and a wrong code is
    // then a *countable* wrong code rather than a malformed request.
    const lowercase = EmailSignInVerifyRequestSchema.safeParse({
      request_id: REQUEST_ID,
      code: '  rnp4-4y37 ',
    })
    expect(lowercase.success).toBe(true)
    expect(lowercase.success && lowercase.data.code).toBe('RNP4-4Y37')
  })

  test('the ambiguity refusal carries the choices, the others carry their own fields', () => {
    const ambiguous = EmailSignInErrorSchema.parse({
      error: 'workspace_ambiguous',
      workspaces: [acme, beta],
    })
    expect(ambiguous).toEqual({ error: 'workspace_ambiguous', workspaces: [acme, beta] })
    expect(EmailSignInErrorSchema.parse({ error: 'invalid_code', attempts_remaining: 0 })).toEqual({
      error: 'invalid_code',
      attempts_remaining: 0,
    })
    expect(EmailSignInErrorSchema.parse({ error: 'expired' })).toEqual({ error: 'expired' })
    // `retryAfterSeconds`, not `retry_after`: this member is the shared
    // ApiRateLimitErrorSchema every rate-limited endpoint already emits, so the
    // spelling follows the API rather than this rail's snake_case body fields.
    expect(EmailSignInErrorSchema.parse({ error: 'rate_limited', retryAfterSeconds: 60 })).toEqual({
      error: 'rate_limited',
      retryAfterSeconds: 60,
    })
    expect(
      EmailSignInErrorSchema.safeParse({ error: 'rate_limited', retry_after: 60 }).success,
    ).toBe(false)
    // `forbidden` and `invalid_request` ARE raised by the route — this
    // assertion used to claim they were not, which made the published union
    // wrong in the direction that matters: it taught a reader the shape was
    // exhaustive when two refusals were missing from it.
    expect(EmailSignInErrorSchema.safeParse({ error: 'forbidden' }).success).toBe(true)
    expect(EmailSignInErrorSchema.safeParse({ error: 'invalid_request' }).success).toBe(true)
    // One that genuinely is not in the vocabulary.
    expect(EmailSignInErrorSchema.safeParse({ error: 'teapot' }).success).toBe(false)
    // `attempts_remaining` reaching zero is a real state; a negative one is not.
    expect(
      EmailSignInErrorSchema.safeParse({ error: 'invalid_code', attempts_remaining: -1 }).success,
    ).toBe(false)
  })

  test('every schema renders as JSON Schema in both directions', () => {
    // Slices 09 and 10 register these, and `apps/docs`' verify:endpoints walks
    // the registry through exactly this call. A `.transform()` or `.pipe()`
    // added here fails the docs build, not this package's types.
    for (const schema of [
      EmailSignInStartRequestSchema,
      EmailSignInStartResponseSchema,
      EmailSignInVerifyRequestSchema,
      EmailSignInVerifyResponseSchema,
      EmailSignInErrorSchema,
    ])
      for (const io of ['input', 'output'] as const)
        expect(() => toJSONSchema(schema, { io })).not.toThrow()
  })

  test('the public barrel loads without an auth/workspace initialization cycle', () => {
    // Guards the import cycle these schemas introduce: they need `workspaces`'
    // role grammar, and `workspaces` needs the auth module's credential kind.
    // Fusing those two files back together throws a TDZ ReferenceError here.
    expect(contract.ApiCredentialKindSchema.parse('browser_session')).toBe('browser_session')
  })

})
