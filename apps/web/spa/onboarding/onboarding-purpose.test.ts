import { describe, expect, test } from 'bun:test'

import { WORKSPACE_PURPOSE_MAX_LENGTH } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { composePurpose, customPurpose } from './onboarding-purpose'

/**
 * Walks the nested `duetOnboarding` message tree the way the app's i18n layer
 * would, returning raw message strings (templates keep their `{answer}`
 * placeholders — composePurpose splices them itself).
 */
function resolverFor(messages: { duetOnboarding: unknown }) {
  return (key: string): string => {
    let node: unknown = messages.duetOnboarding
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object') break
      node = (node as Record<string, unknown>)[part]
    }
    if (typeof node !== 'string') throw new Error(`Missing duetOnboarding message: ${key}`)
    return node
  }
}

const en = resolverFor(appEn)

describe('composePurpose defaults-only (the no-typing guarantee)', () => {
  test('grow-business composes the spec golden paragraph', () => {
    // Two sentences is the whole stored purpose now: the goal, and the one
    // thing the reader said to point an agent at.
    expect(composePurpose({ goalId: 'grow-business' }, en)).toBe(
      'Goal: grow my business. First job: SEO and content.',
    )
  })

  test('launch-project composes from its defaults', () => {
    expect(composePurpose({ goalId: 'launch-project' }, en)).toBe(
      'Goal: launch my project. Hardest part: actually building it.',
    )
  })

  test('replace-software composes from its defaults', () => {
    expect(composePurpose({ goalId: 'replace-software' }, en)).toBe(
      'Goal: replace my existing software. Replacing: a pile of spreadsheets.',
    )
  })

  test('mid-sentence casing lowers plain capitals but leaves acronyms alone', () => {
    // Both halves of midSentence: the acronym survives, the plain capital does
    // not — pinned independently of which chip happens to be the default.
    expect(
      composePurpose({ goalId: 'grow-business', answers: { 'first-job': 'content-seo' } }, en),
    ).toContain('First job: SEO and content.')
    expect(
      composePurpose({ goalId: 'grow-business', answers: { 'first-job': 'outreach' } }, en),
    ).toContain('First job: writing the outreach.')
  })
})

describe('composePurpose with tapped chips and details', () => {
  test('changed chips replace their sentence answers', () => {
    expect(
      composePurpose({ goalId: 'launch-project', answers: { 'hardest-part': 'first-users' } }, en),
    ).toBe('Goal: launch my project. Hardest part: finding the first users.')
  })

  test('an unknown chip id falls back to the smart default', () => {
    expect(
      composePurpose({ goalId: 'grow-business', answers: { 'first-job': 'carrier-pigeon' } }, en),
    ).toBe(composePurpose({ goalId: 'grow-business' }, en))
  })

  test('a detail appends in parentheses inside its sentence', () => {
    expect(
      composePurpose(
        { goalId: 'replace-software', details: { replacing: 'three sheets and a Zapier chain' } },
        en,
      ),
    ).toBe(
      'Goal: replace my existing software. Replacing: a pile of spreadsheets (three sheets and a Zapier chain).',
    )
  })

  test('details are trimmed, and blank details are ignored', () => {
    expect(
      composePurpose(
        { goalId: 'grow-business', details: { 'first-job': '  niche SaaS founders  ' } },
        en,
      ),
    ).toBe('Goal: grow my business. First job: SEO and content (niche SaaS founders).')
    expect(composePurpose({ goalId: 'grow-business', details: { 'first-job': '   ' } }, en)).toBe(
      'Goal: grow my business. First job: SEO and content.',
    )
  })

  test('a runaway detail clamps the paragraph to the schema max', () => {
    const composed = composePurpose(
      { goalId: 'grow-business', details: { 'first-job': 'x'.repeat(2000) } },
      en,
    )
    const prefix = 'Goal: grow my business. First job: SEO and content ('
    expect(composed).toBe(prefix + 'x'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH - prefix.length))
  })
})

describe('composePurpose speaks the locale of the labels it is given', () => {
  const es = resolverFor(appEs)

  test('es-419 labels compose with Unicode-aware mid-sentence casing', () => {
    // The whole paragraph, both halves of midSentence, on both the goal and
    // the answer: "Hacer" lowers, the acronym does not. Asserting a prefix
    // here would stop covering the answer's casing entirely.
    expect(composePurpose({ goalId: 'grow-business' }, es)).toBe(
      'Meta: hacer crecer mi negocio. Primera tarea: SEO y contenido.',
    )
    expect(
      composePurpose({ goalId: 'grow-business', answers: { 'first-job': 'outreach' } }, es),
    ).toBe('Meta: hacer crecer mi negocio. Primera tarea: escribir los mensajes de contacto.')
  })

  test('es-419 resolves every sentence template — no leftover placeholders', () => {
    for (const goalId of ['grow-business', 'launch-project', 'replace-software'] as const) {
      expect(composePurpose({ goalId }, es)).not.toContain('{')
    }
  })
})

describe('customPurpose ("Write your own")', () => {
  test('stores typed text verbatim, trimmed', () => {
    expect(customPurpose('  I run a ceramics studio and want help with wholesale orders. ')).toBe(
      'I run a ceramics studio and want help with wholesale orders.',
    )
  })

  test('clamps to the schema max and changes nothing else', () => {
    const text = 'y'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH + 500)
    expect(customPurpose(text)).toBe('y'.repeat(WORKSPACE_PURPOSE_MAX_LENGTH))
  })
})
