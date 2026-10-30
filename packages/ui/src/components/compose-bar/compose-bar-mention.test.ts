import { expect, test } from 'bun:test'

import {
  findMentionTagStart,
  matchMentionTag,
  rankItems,
  renderMentionTag,
} from './compose-bar-mention'

const SKILL = { tag: 'Skill', attributes: ['name', 'path'] } as const
const FILE = { tag: 'File', attributes: ['path', 'label'] } as const
const AGENT = { tag: 'Agent', attributes: ['name', 'slug', 'path'] } as const

const ITEMS = [
  { name: 'design-review' },
  { name: 'review' },
  { name: 'write-spec' },
  { name: 'reviewer-notes' },
]

test('an exact name outranks the items that merely contain it', () => {
  expect(rankItems(ITEMS, 'review', ['name']).map(item => item.name)).toEqual([
    'review',
    'reviewer-notes',
    'design-review',
  ])
})

test('an empty query keeps the given order', () => {
  expect(rankItems(ITEMS, '', ['name'])).toEqual(ITEMS)
})

test('matching ignores case and hyphen-vs-space typing', () => {
  expect(rankItems(ITEMS, 'Write Spec', ['name']).map(item => item.name)).toContain('write-spec')
})

test('an acronym finds the hyphenated name it abbreviates', () => {
  // The whole reason for fuzzy matching: nobody types `write-spec` in full to
  // reach it, and prefix-only matching (what the agent's terminal picker does)
  // returns nothing here.
  expect(rankItems(ITEMS, 'wsp', ['name']).map(item => item.name)).toContain('write-spec')
})

test('a query matching nothing returns nothing, rather than everything', () => {
  expect(rankItems(ITEMS, 'zzzzz', ['name'])).toEqual([])
})

test('a tighter threshold refuses a word that merely shares some letters', () => {
  // `@` gets typed about people who are not agents. At the default looseness a
  // subsequence was enough — "sarah" is inside "c-a-r-t-og-r-a-p-h-er" — so the
  // picker offered a colleague nobody named and a reflexive Enter inserted it.
  const colleagues = [
    { name: 'Cartographer', slug: 'cartographer' },
    { name: 'Duet', slug: 'root' },
    { name: 'Librarian', slug: 'librarian' },
  ]
  const search = (query: string) =>
    rankItems(colleagues, query, ['name', 'slug'], 0.4).map(item => item.slug)

  expect(search('sarah')).toEqual([])
  expect(search('dave')).toEqual([])
  expect(search('alice')).toEqual([])
  // What people actually type to reach these agents still reaches them.
  expect(search('cart')).toEqual(['cartographer'])
  expect(search('lib')).toEqual(['librarian'])
  expect(search('duet')).toEqual(['root'])
})

test('a second key finds the item its display name alone would hide', () => {
  // Two colleagues answering to one name is expected, so the field that tells
  // them apart has to be searchable — otherwise the only way to reach the
  // second is to scroll past a row that looks identical.
  const colleagues = [
    { name: 'Scout', slug: 'scout' },
    { name: 'Scout', slug: 'scout-web' },
  ]

  // Fuzzy matching still surfaces the sibling — the contract is the order:
  // the colleague whose slug was typed comes first.
  expect(rankItems(colleagues, 'scout-web', ['name', 'slug'])[0]).toEqual({
    name: 'Scout',
    slug: 'scout-web',
  })
  // Searching the name alone cannot tell them apart at all.
  expect(rankItems(colleagues, 'scout-web', ['name'])[0]).toEqual({
    name: 'Scout',
    slug: 'scout',
  })
})

test('a tag carries its spec’s attributes, with quotes neutralized', () => {
  expect(renderMentionTag(SKILL, { name: 'review', path: '/skills/review' })).toBe(
    '<Skill name="review" path="/skills/review" />',
  )
  expect(renderMentionTag(SKILL, { name: 'review', path: '/skills/"odd"' })).toBe(
    '<Skill name="review" path="/skills/&quot;odd&quot;" />',
  )
})

test('a rendered tag reads back as the same attributes', () => {
  const attrs = { name: 'write-spec', path: '/home/duet/.duet/skills/write > spec' }
  const tag = renderMentionTag(SKILL, attrs)

  expect(matchMentionTag(SKILL, tag)).toEqual({ attrs, raw: tag })
  expect(matchMentionTag(SKILL, `leading text ${tag}`)).toBeNull()
  expect(matchMentionTag(SKILL, '<SkillSomethingElse name="x" />')).toBeNull()
})

test('reads escaped attributes from an independently authored tag', () => {
  const tag = '<Skill name="review &amp; plan" path="/skills/&quot;odd&quot;/&lt;draft>" />'

  expect(matchMentionTag(SKILL, tag)).toEqual({
    attrs: { name: 'review & plan', path: '/skills/"odd"/<draft>' },
    raw: tag,
  })
})

test('an attribute with no value is left out rather than written empty', () => {
  // Not every item has every attribute: an agent may have no display name of
  // its own, and the drive root has no folder. Writing `name=""` would make
  // the tag claim an empty name rather than none, and the reader on the other
  // side already treats an absent attribute as empty.
  expect(renderMentionTag(AGENT, { slug: 'root', name: 'Duet' })).toBe(
    '<Agent name="Duet" slug="root" />',
  )
  expect(renderMentionTag(AGENT, { slug: 'scout' })).toBe('<Agent slug="scout" />')
})

test('a tag missing an attribute still reads back as the same item', () => {
  const tag = renderMentionTag(AGENT, { slug: 'scout', path: 'agents/scout' })

  expect(matchMentionTag(AGENT, tag)?.attrs).toEqual({
    name: '',
    slug: 'scout',
    path: 'agents/scout',
  })
})

test('an absent attribute reads back as empty, not as a failed match', () => {
  expect(matchMentionTag(SKILL, '<Skill name="no-path" />')).toEqual({
    attrs: { name: 'no-path', path: '' },
    raw: '<Skill name="no-path" />',
  })
})

test('attributes are read by name, so their order in the tag does not matter', () => {
  expect(matchMentionTag(SKILL, '<Skill path="/p" name="review" />')?.attrs).toEqual({
    name: 'review',
    path: '/p',
  })
})

test('one spec never matches another spec’s tag', () => {
  const fileTag = renderMentionTag(FILE, { path: 'notes.md', label: 'notes' })

  expect(fileTag).toBe('<File path="notes.md" label="notes" />')
  expect(matchMentionTag(SKILL, fileTag)).toBeNull()
  expect(matchMentionTag(FILE, renderMentionTag(SKILL, { name: 'r', path: 'p' }))).toBeNull()
})

test('the scan hint finds the spec’s own tag and ignores the other', () => {
  expect(findMentionTagStart(SKILL, 'ship <Skill name="review" />')).toBe(5)
  expect(findMentionTagStart(SKILL, 'ship <File path="a.md" />')).toBe(-1)
  expect(findMentionTagStart(FILE, 'ship <File path="a.md" />')).toBe(5)
})
