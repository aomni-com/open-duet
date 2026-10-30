import { expect, test } from 'bun:test'

import { VERTICALS } from '@/components/landing/for/verticals-spec'
import { getPostBySlug } from '@/lib/blog/content'
import { PUBLIC_SUBSCRIPTION_PLANS, PUBLIC_TIERS } from '@/lib/public-site-config'

import { getLlmsPage, getLlmsPages } from './pages'
import { getLlmsRoutes } from './routes'

test('renders a body for every route it publishes, so no listed URL is empty', async () => {
  const pages = await getLlmsPages()
  const routes = await getLlmsRoutes()

  expect(pages.map(page => page.path)).toEqual(routes.map(route => route.path))
  expect(
    pages
      .filter(page => page.title === '' || page.description === '' || page.markdown.length < 200)
      .map(page => page.path),
  ).toEqual([])
})

// A section built from a filtered list — "related guides" matched by tag, a
// spec's optional array — renders its heading whether or not anything matched.
// Scoped to the pages this module composes; an article's heading structure is
// its author's, and passes through untouched.
test('never renders an empty heading outside fenced code', async () => {
  const empty: string[] = []
  const composed = (await getLlmsRoutes())
    .filter(route => route.kind !== 'editorial')
    .map(route => route.path)

  const level = (line: string) => /^#+/.exec(line)?.[0].length ?? 0

  for (const path of composed) {
    const page = await getLlmsPage(path)
    const lines = (page?.markdown ?? '').split('\n')
    let codeFence: string | undefined
    for (const [index, line] of lines.entries()) {
      const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (codeFence !== undefined) {
        if (
          fence !== undefined &&
          fence[0] === codeFence[0] &&
          fence.length >= codeFence.length &&
          line.trim() === fence
        )
          codeFence = undefined
        continue
      }
      if (fence !== undefined) {
        codeFence = fence
        continue
      }
      if (level(line) === 0) continue
      const next = lines.slice(index + 1).find(candidate => candidate.trim() !== '')
      // A deeper heading is this section's content; a sibling one, or the end
      // of the document, means the section rendered nothing.
      if (next === undefined || (level(next) !== 0 && level(next) <= level(line))) {
        empty.push(`${path}: ${line}`)
      }
    }
  }

  expect(empty).toEqual([])
})

test('returns nothing for a path the site does not publish', async () => {
  expect(await getLlmsPage('/vs/chatgpt')).toBeNull()
  expect(await getLlmsPage('/es/pricing')).toBeNull()
})

test('carries the article body for an editorial page, not just its frontmatter', async () => {
  const post = getPostBySlug('claude-code-vs-cursor-vs-codex')
  const page = await getLlmsPage('/blog/claude-code-vs-cursor-vs-codex')

  expect(page?.title).toBe(post?.title ?? '')
  expect(page?.markdown.startsWith(`# ${post?.title}`)).toBeTrue()
  // A distinctive sentence from the body, not the description.
  expect(page?.markdown).toContain(post?.content.split('\n').filter(Boolean)[2] ?? 'unreachable')
})

test('renders a vertical from its spec: subhead, outcomes and FAQ answers', async () => {
  const roofers = VERTICALS.find(vertical => vertical.slug === 'roofers')
  if (roofers === undefined) throw new Error('roofers vertical missing from spec')
  const page = await getLlmsPage('/for/roofers')

  expect(page?.markdown).toContain(roofers.heroSubhead)
  expect(page?.markdown).toContain(roofers.kickoffPrompt)
  for (const outcome of roofers.outcomes) expect(page?.markdown).toContain(outcome.body)
  for (const faq of roofers.faqs) expect(page?.markdown).toContain(faq.a)
})

test('drops the SERP brand suffix from a title about to sit under a Duet heading', async () => {
  const page = await getLlmsPage('/pricing')

  expect(page?.title).toBe('Pricing')
  expect(page?.markdown.startsWith('# Pricing\n')).toBeTrue()
})

test('states pricing from the product contract instead of a marketing copy of it', async () => {
  const page = await getLlmsPage('/pricing')

  for (const plan of PUBLIC_SUBSCRIPTION_PLANS) expect(page?.markdown).toContain(plan.monthlyPrice)
  for (const tier of PUBLIC_TIERS) expect(page?.markdown).toContain(tier.label)
})
