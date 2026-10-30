import { describe, expect, test } from 'bun:test'

import { HOME_COPY } from '@/components/landing/landers/home-copy'
import type { AppLocale } from '@/lib/i18n/locales'

/**
 * The main lander sells one thing in both languages: one subscription that
 * puts every kind of state-of-the-art AI in reach of someone who will not set
 * it up themselves (positioning.md at the repo root owns the why). These pin
 * the ways that promise drifts: a lead that stops saying "one subscription",
 * a lead that lets the reader assume AI means text, engineering vocabulary the
 * audience never asked to learn, claims the product does not back (the
 * marketplace is not open to sellers), and dash-spliced sentences that read as
 * machine-written.
 */

/** Every string the page says, however deeply the copy nests it. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

const PROMISE: Record<AppLocale, { subscription: RegExp; beyondText: readonly RegExp[] }> = {
  en: { subscription: /subscription/i, beyondText: [/image/i, /video/i, /voice/i] },
  'es-419': { subscription: /suscripci[oó]n/i, beyondText: [/im[aá]gen/i, /video/i, /voz/i] },
}

/** Words that tell this audience the product is for engineers. */
const ENGINEERING = /\b(mcp|api|cli|vm|sandbox|gateway|terminal)\b/i

for (const locale of Object.keys(HOME_COPY) as AppLocale[]) {
  const copy = HOME_COPY[locale]
  const everything = strings(copy).join('\n')

  describe(`the main lander copy (${locale})`, () => {
    test('leads with one subscription', () => {
      const { subscription } = PROMISE[locale]
      for (const lead of [copy.title, copy.description, copy.hero.lead]) {
        expect(lead).toMatch(subscription)
      }
    })

    test('names what AI can do beyond text, right under the headline', () => {
      for (const kind of PROMISE[locale].beyondText) expect(copy.hero.sub).toMatch(kind)
    })

    test('speaks without engineering vocabulary', () => {
      expect(everything).not.toMatch(ENGINEERING)
    })

    test('claims nothing the product does not back', () => {
      expect(everything).not.toMatch(/marketplace/i)
    })

    test('is written in whole sentences, without em dashes', () => {
      expect(everything).not.toContain('—')
    })
  })
}

test('every locale says the same number of things', () => {
  const shape = (locale: AppLocale) => {
    const copy = HOME_COPY[locale]
    return [
      copy.outcomes.pillars.length,
      copy.setup.before.items.length,
      copy.share.cards.length,
      copy.faq.items.length,
      copy.close.bullets.length,
      copy.train.feed.length,
      copy.train.facetNotes.length,
    ]
  }
  expect(shape('es-419')).toEqual(shape('en'))
})
