import { describe, expect, test } from 'bun:test'

import {
  AppSlugSchema,
  MAX_SLUG_LENGTH,
  ROOT_AGENT_SCOPE,
  NormalizedSlugSchema,
  PublishSlugSchema,
  WorkspaceSlugSchema,
  normalizeSlug,
} from './index'

describe('slug grammar', () => {
  test('accepts lowercase kebab slugs in every public namespace', () => {
    for (const schema of [WorkspaceSlugSchema, AppSlugSchema, PublishSlugSchema]) {
      expect(schema.parse('acme-drive')).toBe('acme-drive')
      expect(schema.parse('a1-b2')).toBe('a1-b2')
    }
  })

  test('rejects non-kebab forms and the double-hyphen app URL separator', () => {
    for (const slug of ['Acme', 'acme_drive', 'acme--drive', '-acme', 'acme-', 'acme.drive']) {
      expect(WorkspaceSlugSchema.safeParse(slug).success).toBe(false)
    }
  })

  test('bounds length at the v1 maximum', () => {
    expect(WorkspaceSlugSchema.safeParse('a'.repeat(MAX_SLUG_LENGTH)).success).toBe(true)
    expect(WorkspaceSlugSchema.safeParse('a'.repeat(MAX_SLUG_LENGTH + 1)).success).toBe(false)
  })

  test('reserves system routes across workspace, app, and publish namespaces', () => {
    for (const slug of ['api', '_next', 'robots-txt', 'sitemap-xml', 'manifest-webmanifest']) {
      expect(WorkspaceSlugSchema.safeParse(slug).success).toBe(false)
    }
  })

  // `root` names the default agent everywhere — session filters, job filters,
  // and the `/agents/root` route. Reserving it in every namespace is what stops
  // a folder called `root` from registering an agent that shadows that route.
  test('reserves the default-agent token in every namespace', () => {
    for (const schema of [WorkspaceSlugSchema, AppSlugSchema, PublishSlugSchema]) {
      expect(schema.safeParse('root').success).toBe(false)
    }
  })

  // The token now lives in this module, beside the reservation it names — one
  // spelling, no drift to pin. This guards the pair staying together.
  test('rejects ROOT_AGENT_SCOPE itself, not merely a matching literal', () => {
    expect(AppSlugSchema.safeParse(ROOT_AGENT_SCOPE).success).toBe(false)
  })

  // Normalization runs before validation, so the reservation has to survive it —
  // otherwise `Root` and ` root ` normalize into the reserved word and through.
  test('reserves the token through normalization', () => {
    for (const raw of ['Root', '  root  ', 'ROOT']) {
      expect(NormalizedSlugSchema.safeParse(raw).success).toBe(false)
    }
  })
})

describe('slug normalization', () => {
  test('canonicalizes accents, punctuation, case, repeated dashes, and surrounding separators', () => {
    expect(normalizeSlug('  Café___DUET!!!  ')).toBe('cafe-duet')
    expect(NormalizedSlugSchema.parse('Acme Workspace')).toBe('acme-workspace')
  })

  test('truncates without leaving a trailing hyphen', () => {
    const raw = `${'a'.repeat(MAX_SLUG_LENGTH - 1)}!!!tail`
    expect(normalizeSlug(raw)).toBe('a'.repeat(MAX_SLUG_LENGTH - 1))
  })

  test('normalized reserved system files are still rejected', () => {
    expect(() => NormalizedSlugSchema.parse('robots.txt')).toThrow('reserved')
    expect(() => NormalizedSlugSchema.parse('manifest.webmanifest')).toThrow('reserved')
  })
})
