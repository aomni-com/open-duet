import { describe, expect, test } from 'bun:test'

import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { ORGANIZATION_JSON_LD } from '@/components/landing/organization-json-ld'
import type { AppLocale } from '@/lib/i18n/locales'
import { PUBLIC_SUBSCRIPTION_PLANS } from '@/lib/public-site-config'
import { homeJsonLd } from '@/lib/seo/home-json-ld'

/**
 * The homepage's structured data is what a search engine or an answer engine
 * reads instead of the page, so it has to say what the page says: the same
 * promise, the same questions, and the current plan range.
 */

type Node = Record<string, unknown> & { '@type': string }

function node(graph: readonly Node[], type: string): Node {
  const found = graph.find(entry => entry['@type'] === type)
  if (!found) throw new Error(`no ${type} node`)
  return found
}

for (const locale of Object.keys(HOME_COPY) as AppLocale[]) {
  const copy = HOME_COPY[locale]
  const graph = homeJsonLd(locale)['@graph'] as readonly Node[]

  describe(`the homepage structured data (${locale})`, () => {
    test('describes the page with its own promise', () => {
      expect(node(graph, 'WebPage').name).toBe(copy.title)
      for (const type of ['WebPage', 'Organization', 'SoftwareApplication']) {
        expect(node(graph, type).description).toBe(copy.description)
      }
    })

    test('mirrors the questions the page answers', () => {
      const questions = node(graph, 'FAQPage').mainEntity as Array<{ name: string }>
      expect(questions.map(q => q.name)).toEqual(copy.faq.items.map(item => item.q))
    })

    test('offers the real plan range while preserving the self-serve copy', () => {
      const offers = node(graph, 'SoftwareApplication').offers as Record<string, unknown>
      const prices = PUBLIC_SUBSCRIPTION_PLANS.map(plan => Number(plan.monthlyPrice.slice(1)))
      expect(offers['@type']).toBe('AggregateOffer')
      expect(offers.lowPrice).toBe(String(Math.min(...prices)))
      expect(offers.highPrice).toBe(String(Math.max(...prices)))
      expect(String(offers.url)).toMatch(/\/pricing$/)
      expect(JSON.stringify(graph)).toMatch(locale === 'en' ? /7-day trial/i : /prueba de 7 días/i)
    })
  })
}

test('the site-wide organization tells the same story as the homepage', () => {
  expect(ORGANIZATION_JSON_LD.description).toBe(HOME_COPY.en.description)
})
