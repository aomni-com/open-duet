import { expect, test } from 'bun:test'

import { MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH } from '@repo/contract'

import {
  recommendAgents,
  type RecommendationCatalogEntry,
  type RecommendationGenerationRequest,
} from './recommendationsCore'

function entry(
  agentName: string,
  title: string,
  tags: RecommendationCatalogEntry['tags'],
  summary: string,
): RecommendationCatalogEntry {
  return { agentName, title, tags, summary }
}

const catalog: RecommendationCatalogEntry[] = [
  entry('scribe', 'Scribe', ['marketing'], 'Drafts blog posts and newsletters from a brief.'),
  entry('seo-scout', 'SEO Scout', ['marketing'], 'Finds keywords and fixes on-page SEO.'),
  entry('inbox-zero', 'Inbox Zero', ['operations'], 'Triages and answers routine email.'),
  entry('bookkeeper', 'Bookkeeper', [], 'Keeps your invoices and expenses reconciled.'),
  entry('prospector', 'Prospector', ['sales'], 'Builds lead lists and drafts outreach.'),
]

function pick(agentName: string, reason = `Because you asked, ${agentName} helps directly.`) {
  return { agentName, reason }
}

test('recommendation flow feeds the catalog and purpose to the model and returns its four picks', async () => {
  let request: RecommendationGenerationRequest | undefined
  const result = await recommendAgents({
    purpose: 'Grow my bakery with weekly content and less admin busywork.',
    tagHints: ['marketing', 'operations'],
    catalog,
    generate: async input => {
      request = input
      return {
        recommendations: [
          pick('scribe'),
          pick('seo-scout'),
          pick('inbox-zero'),
          pick('bookkeeper'),
        ],
      }
    },
  })

  expect(result).toEqual({
    recommendations: [pick('scribe'), pick('seo-scout'), pick('inbox-zero'), pick('bookkeeper')],
  })
  expect(request!.system).toContain(
    'scribe | Scribe | marketing | Drafts blog posts and newsletters from a brief.',
  )
  expect(request!.system).toContain('bookkeeper | Bookkeeper |  | Keeps your invoices')
  expect(request!.prompt).toContain('Grow my bakery with weekly content and less admin busywork.')
  expect(request!.prompt).toContain('Emphasis: marketing, operations')
})

test('fabricated agent names are dropped and the four real picks survive', async () => {
  const result = await recommendAgents({
    purpose: 'Sell more.',
    catalog,
    generate: async () => ({
      recommendations: [
        pick('prospector'),
        pick('made-up-agent'),
        pick('scribe'),
        pick('inbox-zero'),
        pick('bookkeeper'),
      ],
    }),
  })

  expect(result.recommendations.map(item => item.agentName)).toEqual([
    'prospector',
    'scribe',
    'inbox-zero',
    'bookkeeper',
  ])
})

test('duplicates dedupe to the first occurrence and the list caps at four', async () => {
  const result = await recommendAgents({
    purpose: 'Sell more.',
    catalog,
    generate: async () => ({
      recommendations: [
        pick('prospector', 'First mention wins.'),
        pick('prospector', 'Second mention loses.'),
        pick('scribe'),
        pick('inbox-zero'),
        pick('bookkeeper'),
        pick('seo-scout'),
      ],
    }),
  })

  expect(result.recommendations).toEqual([
    { agentName: 'prospector', reason: 'First mention wins.' },
    pick('scribe'),
    pick('inbox-zero'),
    pick('bookkeeper'),
  ])
})

test('fewer than four survivors collapse to an empty list, never a partial one', async () => {
  const result = await recommendAgents({
    purpose: 'Sell more.',
    catalog,
    generate: async () => ({
      recommendations: [pick('prospector'), pick('scribe'), pick('fabricated'), pick('invented')],
    }),
  })

  expect(result).toEqual({ recommendations: [] })
})

test('a timed-out generation yields empty recommendations, not an error', async () => {
  const result = await recommendAgents({
    purpose: 'Sell more.',
    catalog,
    generate: async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    },
  })

  expect(result).toEqual({ recommendations: [] })
})

test('an empty catalog yields empty recommendations without calling the model', async () => {
  let calls = 0
  const result = await recommendAgents({
    purpose: 'Sell more.',
    catalog: [],
    generate: async () => {
      calls += 1
      return { recommendations: [pick('scribe')] }
    },
  })

  expect(result).toEqual({ recommendations: [] })
  expect(calls).toBe(0)
})

test('reasons are trimmed and clamped to the wire limit; blank reasons drop the pick', async () => {
  const longReason = `You said sell more. ${'Detail. '.repeat(MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH)}`
  const clamped = await recommendAgents({
    purpose: 'Sell more.',
    catalog,
    generate: async () => ({
      recommendations: [
        pick('prospector', `  ${longReason}  `),
        pick('scribe'),
        pick('inbox-zero'),
        pick('bookkeeper'),
      ],
    }),
  })
  expect(clamped.recommendations[0]).toEqual({
    agentName: 'prospector',
    reason: longReason.trim().slice(0, MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH),
  })

  const blank = await recommendAgents({
    purpose: 'Sell more.',
    catalog,
    generate: async () => ({
      recommendations: [
        pick('prospector', '   '),
        pick('scribe'),
        pick('inbox-zero'),
        pick('bookkeeper'),
      ],
    }),
  })
  expect(blank).toEqual({ recommendations: [] })
})
