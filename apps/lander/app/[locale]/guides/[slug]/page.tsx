import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'
import { MDXRemote } from 'next-mdx-remote/rsc'
import { notFound } from 'next/navigation'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'

import { GuideLayout } from '@/components/blog/guide-layout'
import { mdxComponents } from '@/components/blog/mdx-components'
import {
  getAllGuides,
  getGuideBySlug,
  getRelatedGuides,
  getTranslatedLocalesForPost,
  hasTranslatedContent,
} from '@/lib/blog/content'
import {
  extractFaqFromContent,
  generateBreadcrumbJsonLd,
  generateFaqJsonLd,
  generateGuideJsonLd,
  generateHowToJsonLd,
} from '@/lib/blog/seo'
import {
  isEsHreflangSuppressedSlug,
  isNoindexedEsEditorialSlug,
} from '@/lib/i18n/es-editorial-indexing'
import { localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { localizedCanonical } from '@/lib/i18n/metadata'

type Props = { params: Promise<{ locale: AppLocale; slug: string }> }

export async function generateStaticParams() {
  return getAllGuides().flatMap(guide =>
    getTranslatedLocalesForPost('guides', guide.slug).map(locale => ({ locale, slug: guide.slug })),
  )
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params
  const guide = getGuideBySlug(slug, locale)
  if (!guide) return {}

  const ogImage = guide.image ?? '/landing/duet-lander-image.jpg'
  // English fallback under a non-default locale → canonical at the English
  // URL + noindex so we don't ship an indexable untranslated duplicate.
  const isFallback = !hasTranslatedContent('guides', slug, locale)
  const url = isFallback
    ? localizedCanonical(`/guides/${slug}`, 'en')
    : localizedCanonical(`/guides/${slug}`, locale)
  const translatedLocales = getTranslatedLocalesForPost('guides', slug)
  // Bucket B/C `/es` guides: drop the `es` hreflang from the cluster so the EN
  // original never advertises a redirected/noindexed alternate.
  const hreflangLocales = isEsHreflangSuppressedSlug('guides', slug)
    ? translatedLocales.filter(l => l === 'en')
    : translatedLocales
  // Bucket C: noindex only the es-419 variant — the EN original stays indexed.
  const isNoindexEs = locale === 'es-419' && isNoindexedEsEditorialSlug('guides', slug)
  const pageTitle = guide.metaTitle ?? `${guide.title} | Duet Guides`

  return {
    title: pageTitle,
    description: guide.description,
    robots: isFallback || isNoindexEs ? { index: false, follow: true } : undefined,
    openGraph: {
      title: guide.metaTitle ?? guide.title,
      description: guide.description,
      type: 'article',
      publishedTime: guide.date,
      modifiedTime: guide.updatedAt,
      images: [{ url: ogImage, width: 1200, height: 630, alt: guide.title }],
      url,
    },
    twitter: {
      card: 'summary_large_image',
      title: guide.metaTitle ?? guide.title,
      description: guide.description,
      images: [ogImage],
    },
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(
          hreflangLocales.map(l => [
            localeMetadata[l].hreflang,
            localizedCanonical(`/guides/${slug}`, l),
          ]),
        ),
        'x-default': localizedCanonical(`/guides/${slug}`, 'en'),
      },
    },
  }
}

export default async function GuidePage({ params }: Props) {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const guide = getGuideBySlug(slug, locale)
  if (!guide) notFound()

  const guideJsonLd = generateGuideJsonLd(guide, locale)
  const breadcrumbJsonLd = generateBreadcrumbJsonLd(
    [
      { name: 'Guides', url: '/guides' },
      { name: guide.title, url: `/guides/${slug}` },
    ],
    locale,
  )
  const faqItems = extractFaqFromContent(guide.content)
  const faqJsonLd = generateFaqJsonLd(faqItems)
  const howToJsonLd = guide.howTo ? generateHowToJsonLd(guide.howTo) : null
  const relatedGuides = getRelatedGuides(guide)

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(guideJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}
      {howToJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(howToJsonLd) }}
        />
      )}
      <GuideLayout post={guide} slug={slug} relatedGuides={relatedGuides}>
        <MDXRemote
          source={guide.content}
          components={mdxComponents}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] } }}
        />
      </GuideLayout>
    </>
  )
}
