import { expect, test } from 'bun:test'

import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { PUBLIC_SUBSCRIPTION_PLANS, PUBLIC_TIERS } from '@/lib/public-site-config'

import { buildLlmsFullText, buildLlmsIndex } from './index-text'
import { absoluteUrl } from './markdown'
import { mdRewriteTarget, mdRoutePath, mdTwinPath } from './md-url'
import { getLlmsPages } from './pages'

/** One `##` section's body, so a rule about the copy is asserted on the copy. */
function sectionOf(index: string, title: string): string {
  return (index.split(`\n## ${title}\n`)[1] ?? '').split('\n## ')[0] ?? ''
}

test('opens with the spec header a reader keys off: one H1 and one blockquote summary', async () => {
  const index = (await buildLlmsIndex()).split('\n')

  expect(index[0]).toBe('# Duet')
  expect(index[2]?.startsWith('> ')).toBeTrue()
})

// The `.md` twin rather than the page: `app/robots.ts` allows an AI crawler
// `*.md` site-wide but allows the styled pages only in the editorial trees, so
// linking the page hands most readers of this file a link they may not follow.
test('links every published page exactly once, at its twin’s absolute URL', async () => {
  const index = await buildLlmsIndex()
  const pages = await getLlmsPages()

  for (const page of pages) {
    const occurrences = index.split(`](${absoluteUrl(mdTwinPath(page.path))})`).length - 1
    expect([page.path, occurrences]).toEqual([page.path, 1])
  }
})

// A twin URL that does not rewrite back onto a prerendered route is a 404,
// which is worse than a link the crawler was barred from following.
test('every linked twin resolves to a route the build prerenders', async () => {
  const index = await buildLlmsIndex()
  const linked = [...index.matchAll(new RegExp(`]\\(${LANDER_ORIGIN}([^)]*\\.md)\\)`, 'g'))].map(
    match => mdRewriteTarget(match[1] ?? ''),
  )
  const prerendered = new Set((await getLlmsPages()).map(page => mdRoutePath(page.path)))

  expect(linked.length).toBeGreaterThan(0)
  expect(linked.filter(target => target === null || !prerendered.has(target))).toEqual([])
})

test('explains the offer inline, because a bot that fetches nothing else still learns it', async () => {
  const index = await buildLlmsIndex()

  for (const tier of PUBLIC_TIERS) expect(index).toContain(tier.label)
  for (const plan of PUBLIC_SUBSCRIPTION_PLANS) expect(index).toContain(plan.monthlyPrice)
  expect(index).toContain(`${LANDER_ORIGIN}/llms-full.txt`)
})

test('teaches the whole sign-in transcript, including what the agent cannot do itself', async () => {
  const index = await buildLlmsIndex()

  expect(index).toContain('/v1/auth/email/start')
  expect(index).toContain('/v1/auth/email/verify')
  expect(index).toContain('XXXX-XXXX')
  expect(index).toContain('workspace_ambiguous')
  expect(index).toContain('retryAfterSeconds')
  // `workspace_name` on a returning human is ignored, not applied; an agent
  // that believes otherwise reports a rename that never happened.
  expect(index).toContain('silently ignored')
  // A human can manage the same named keys through either public surface.
  expect(index).toContain('/settings/api-keys')
  expect(index).toContain('/v1/user/api-keys/{keyId}')
  expect(index).not.toContain('duetfs')
})

// Decisions 13 and 14 removed the scope knob from this rail. Copy that
// reintroduces the vocabulary teaches an agent to ask for a parameter no
// endpoint accepts.
test('offers no capability or scope vocabulary to reintroduce a knob that was removed', async () => {
  const index = await buildLlmsIndex()
  const agentCopy = ['Authentication', 'Pricing and subscribing'].map(title =>
    sectionOf(index, title),
  )

  expect(agentCopy.filter(body => body.length < 200)).toEqual([])
  for (const word of ['scope', 'capabilit']) {
    expect([word, agentCopy.filter(body => new RegExp(word, 'i').test(body))]).toEqual([word, []])
  }
})

test('names both subscribe triggers and whose plan clears them', async () => {
  const index = await buildLlmsIndex()

  expect(index).toContain('subscription_required')
  expect(index).toContain('workspace_limit_reached')
  expect(index).toContain('/v1/user/billing/subscription/checkout')
  // The payer split: a plan belongs to a person, so the human who signed in
  // may not be the human who can pay.
  expect(index).toContain('A plan belongs to a person, not to a workspace.')
  for (const plan of PUBLIC_SUBSCRIPTION_PLANS) {
    expect(index).toContain(`${plan.id} ${plan.workspaceLimit}`)
  }
})

// The index is read whole by a machine with everything else to do. Prose here
// is bought at the cost of attention, so growth is a decision, not a drift.
test('tells an agent where entitlement is readable before a refusal arrives', async () => {
  // Decision 6 makes `funding` THE way an agent reads entitlement. It shipped
  // required on every workspace summary and then had no reader anywhere — not
  // in the product, not in this file — which a closeout review caught. Pointing
  // at it is what makes the decision delivered rather than merely built.
  const index = await buildLlmsIndex()
  expect(index).toContain('GET /v1/whoami')
  expect(index).toContain('funding')
})

test('stays inside its length budget', async () => {
  expect((await buildLlmsIndex()).split('\n').length).toBeLessThan(300)
})

test('never points a reader at a path it has to resolve itself', async () => {
  const index = await buildLlmsIndex()
  const relative = [...index.matchAll(/]\((?!https?:)([^)]*)\)/g)].map(match => match[1])

  expect(relative).toEqual([])
})

test('carries every page body in the full text, each under its own URL', async () => {
  const full = await buildLlmsFullText()
  const pages = await getLlmsPages()

  for (const page of pages) {
    expect(full).toContain(absoluteUrl(page.path))
    expect(full).toContain(page.markdown)
  }
})
