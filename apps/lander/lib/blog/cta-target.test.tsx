import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import { DuetCTA } from '@/components/blog/duet-cta'
import { getAllPosts } from '@/lib/blog/content'
import { resolveConfiguredProductOrigin } from '@/src/config/origins'

// A post's CTA names a path; the site decides which origin serves it. These
// two posts are the ends of that: one aims at a lander page, one at the
// product. `verify-public-content` proves the paths are routable at all.
test('post CTAs resolve lander and product targets through their owning origins', () => {
  const posts = getAllPosts()
  const landerPost = posts.find(post => post.slug === 'enterprise-ai-stack')
  const productPost = posts.find(post => post.slug === 'kimi-k3-open-source-ai-models')
  expect(landerPost).toBeDefined()
  expect(productPost).toBeDefined()

  const landerHtml = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <DuetCTA {...landerPost!.cta} />
    </NextIntlClientProvider>,
  )
  const productHtml = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <DuetCTA {...productPost!.cta} />
    </NextIntlClientProvider>,
  )

  expect(landerHtml).toContain('href="/pricing"')
  expect(productHtml).toContain(
    `href="${resolveConfiguredProductOrigin()}/sign-in?from=blog-kimi-k3-open-source"`,
  )
})
