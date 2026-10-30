import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'

import {
  SkillsBundleSchema,
  WorkspaceSkillsListQuerySchema,
  WorkspaceSkillsPageSchema,
  WorkspaceSkillsListingSchema,
  type SkillsBundle,
} from './index'

describe('WorkspaceSkillsListingSchema', () => {
  test('keeps a skill whose scope a newer agent invented, without its scope', () => {
    const parsed = WorkspaceSkillsListingSchema.parse({
      skills: [
        { name: 'review', description: 'Closeout pass', path: '/drive/.agents/skills/review' },
        { name: 'plan', path: '/home/duet/.duet/skills/plan', scope: 'user' },
        { name: 'ephemeral', path: '/tmp/ephemeral', scope: 'from-the-future' },
      ],
      collisions: [{ name: 'review', winnerPath: '/a', loserPath: '/b' }],
    })

    expect(parsed).toEqual({
      skills: [
        { name: 'review', description: 'Closeout pass', path: '/drive/.agents/skills/review' },
        { name: 'plan', path: '/home/duet/.duet/skills/plan', scope: 'user' },
        { name: 'ephemeral', path: '/tmp/ephemeral' },
      ],
    })
  })

  test('drops a nameless or pathless row rather than failing the whole listing', () => {
    const parsed = WorkspaceSkillsListingSchema.parse({
      skills: [{ name: '', path: '/a' }, { name: 'review' }, { name: 'plan', path: '/b' }],
    })

    expect(parsed.skills).toEqual([{ name: 'plan', path: '/b' }])
  })
})

describe('workspace skills collection contract', () => {
  test('uses the strict universal query and page envelope', () => {
    expect(WorkspaceSkillsListQuerySchema.parse({ cwd: 'agents/scout' })).toEqual({
      cwd: 'agents/scout',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(WorkspaceSkillsListQuerySchema.parse({ limit: String(COLLECTION_PAGE_MAX_LIMIT) })).toEqual({ limit: COLLECTION_PAGE_MAX_LIMIT })
    expect(
      WorkspaceSkillsListQuerySchema.safeParse({ cwd: 'agents/scout', limit: String(COLLECTION_PAGE_MAX_LIMIT + 1) }).success,
    ).toBe(false)
    expect(
      WorkspaceSkillsListQuerySchema.safeParse({ cwd: 'agents/scout', extra: 'nope' }).success,
    ).toBe(false)
    expect(WorkspaceSkillsPageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(WorkspaceSkillsPageSchema.safeParse({ skills: [], nextCursor: null }).success).toBe(
      false,
    )
  })
})

describe('SkillsBundleSchema', () => {
  test('validates canonical manifest fields while stripping unknown ones', () => {
    const canonical: SkillsBundle = {
      version: 1,
      files: [
        { path: 'fixture/A.txt', content: 'first' },
        { path: 'fixture/b.txt', content: 'second' },
      ],
    }

    expect(SkillsBundleSchema.parse(canonical)).toEqual(canonical)
    expect(SkillsBundleSchema.parse({ ...canonical, extra: true })).toEqual(canonical)
    expect(
      SkillsBundleSchema.parse({
        ...canonical,
        files: [{ ...canonical.files[0], extra: true }],
      }),
    ).toEqual({ ...canonical, files: [canonical.files[0]!] })
    expect(() =>
      SkillsBundleSchema.parse({ ...canonical, files: [...canonical.files].reverse() }),
    ).toThrow(/sorted/i)
    expect(() =>
      SkillsBundleSchema.parse({
        ...canonical,
        files: [canonical.files[0], { ...canonical.files[0] }],
      }),
    ).toThrow(/duplicate/i)
    expect(() =>
      SkillsBundleSchema.parse({
        ...canonical,
        files: [{ path: 'fixture/../outside.txt', content: 'nope' }],
      }),
    ).toThrow(/safe relative path/i)
  })
})
