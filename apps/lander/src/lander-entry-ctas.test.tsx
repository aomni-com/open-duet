import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { FinalCta, LanderHero } from '@/components/landing/landers/hero-and-close'
import { productHref } from '@/src/config/origins'

/**
 * Every public conversion path starts self-serve signup on the configured
 * product origin. The hero and closing band each keep one attributed signup
 * link, with no scheduler destination.
 */

/** The CTAs are locale-aware links, so they render inside the intl provider. */
function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  )
}

function ctas(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs)].map(match => ({
    href: match[1]!,
    text: match[2]!.replace(/<[^>]+>/g, '').trim(),
  }))
}

test('the hero sends visitors to self-serve signup', () => {
  const links = ctas(render(<LanderHero headline="Headline" sub="Sub" />))
  expect(links).toEqual([{ href: productHref('/sign-in?from=lander-hero'), text: 'Start free' }])
})

test('the closing band sends visitors to self-serve signup', () => {
  const html = render(<FinalCta />)
  expect(ctas(html)).toEqual([{ href: productHref('/sign-in?from=lander-final'), text: 'Start free' }])
  expect(html).not.toMatch(/cal\.com|book a call|booking/i)
})

test('the ask speaks the page language', () => {
  const html = render(
    <>
      <LanderHero headline="Titular" sub="Bajada" cta="Comenzar gratis" />
      <FinalCta cta="Comenzar gratis" />
    </>,
  )
  expect(ctas(html)).toEqual([
    { href: productHref('/sign-in?from=lander-hero'), text: 'Comenzar gratis' },
    { href: productHref('/sign-in?from=lander-final'), text: 'Comenzar gratis' },
  ])
})
