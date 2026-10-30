import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { CategoryFilter } from '@/components/blog/category-filter'
import { PostCard } from '@/components/blog/post-card'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { Link } from '@/i18n/navigation'
import { getCategoryDescription, getCategoryName } from '@/lib/blog/categories'
import { getPostsByCategory } from '@/lib/blog/content'
import { BLOG_CATEGORIES, type CategorySlug } from '@/lib/blog/types'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { productHref } from '@/src/config/origins'

type Props = {
  params: Promise<{ locale: 'en' | 'es-419'; category: string }>
}

export function generateStaticParams() {
  return BLOG_CATEGORIES.flatMap(category =>
    (['en', 'es-419'] as const).map(locale => ({ locale, category })),
  )
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, category } = await params

  if (!BLOG_CATEGORIES.includes(category as CategorySlug)) {
    return {}
  }

  const name = getCategoryName(category as CategorySlug, locale)
  const description = getCategoryDescription(category as CategorySlug, locale)
  const path = locale === 'es-419' ? `/es/blog/category/${category}` : `/blog/category/${category}`
  const url = `${LANDER_ORIGIN}${path}`

  return {
    title: `${name} | Duet Blog`,
    description,
    openGraph: {
      title: `${name} Articles | Duet Blog`,
      description,
      type: 'website',
      url,
    },
    alternates: { canonical: url },
    robots: { index: false, follow: true },
  }
}

export default async function CategoryPage({ params }: Props) {
  const { locale, category } = await params

  if (!BLOG_CATEGORIES.includes(category as CategorySlug)) {
    notFound()
  }

  const t = await getTranslations({ locale, namespace: 'blogUi' })
  const name = getCategoryName(category as CategorySlug, locale)
  const description = getCategoryDescription(category as CategorySlug, locale)
  const posts = getPostsByCategory(category as CategorySlug, locale)

  return (
    <LandingChrome noAmbient>
      <LandingNav sticky />

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 md:pt-24">
        <header className="mb-12">
          <p className="mb-5 text-[11px] uppercase tracking-[0.3em] text-white/55">
            {t('category')}
          </p>
          <h1
            className="mb-5 text-5xl font-normal leading-[1] tracking-[-1.25px] text-white md:text-6xl"
            style={serifStyle}
          >
            {name}
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-white/75">{description}</p>
        </header>

        <div className="mb-12">
          <CategoryFilter currentCategory={category as CategorySlug} />
        </div>

        {posts.length === 0 ? (
          <div className="liquid-glass rounded-2xl p-10 text-center">
            <p className="mb-3 text-white">{t('noPostsInCategory')}</p>
            <p className="mb-6 text-sm text-white/65">{t('exploreOther')}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/guides"
                className="inline-flex items-center justify-center rounded-full border border-white/15 bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/10"
              >
                {t('browseGuides')}
              </Link>
              <a
                href={productHref(`/sign-in?from=blog-category-empty&category=${category}`)}
                className="inline-flex items-center justify-center rounded-full bg-[hsl(214_65%_50%)] px-5 py-2.5 text-sm font-medium text-[hsl(0_0%_100%)] shadow-[0_8px_22px_-10px_hsl(214_65%_50%/0.55)] transition-[transform,background-color] hover:-translate-y-0.5 hover:bg-[hsl(214_70%_44%)]"
              >
                {t('startFree')}
              </a>
            </div>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {posts.map(post => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>
        )}
      </main>

      <LandingFooter />
    </LandingChrome>
  )
}
