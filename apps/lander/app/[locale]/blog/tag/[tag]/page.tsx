import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { PostCard } from '@/components/blog/post-card'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { getAllTags, getPostsByTag } from '@/lib/blog/content'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

type Props = {
  params: Promise<{ locale: 'en' | 'es-419'; tag: string }>
}

export function generateStaticParams() {
  return (['en', 'es-419'] as const).flatMap(locale =>
    getAllTags(locale).map(tag => ({ locale, tag })),
  )
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, tag } = await params
  const decodedTag = decodeURIComponent(tag)
  const path =
    locale === 'es-419'
      ? `/es/blog/tag/${encodeURIComponent(decodedTag)}`
      : `/blog/tag/${encodeURIComponent(decodedTag)}`
  const url = `${LANDER_ORIGIN}${path}`
  const description =
    locale === 'es-419'
      ? `Artículos con la etiqueta "${decodedTag}" en el blog de Duet.`
      : `Articles tagged with "${decodedTag}" on the Duet blog.`

  return {
    title: `#${decodedTag} | Duet Blog`,
    description,
    openGraph: {
      title: `#${decodedTag} | Duet Blog`,
      description,
      type: 'website',
      url,
    },
    alternates: { canonical: url },
    robots: { index: false, follow: true },
  }
}

export default async function TagPage({ params }: Props) {
  const { locale, tag } = await params
  const decodedTag = decodeURIComponent(tag)
  const posts = getPostsByTag(decodedTag, locale)
  const t = await getTranslations({ locale, namespace: 'blogUi' })

  return (
    <LandingChrome noAmbient>
      <LandingNav sticky />

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 md:pt-24">
        <header className="mb-12">
          <p className="mb-5 text-[11px] uppercase tracking-[0.3em] text-white/55">{t('tag')}</p>
          <h1
            className="mb-5 text-5xl font-normal leading-[1] tracking-[-1.25px] text-white md:text-6xl"
            style={serifStyle}
          >
            #{decodedTag}
          </h1>
          <p className="text-lg text-white/75">
            {posts.length} {t('tagsArticles', { count: posts.length })} &ldquo;
            {decodedTag}&rdquo;
          </p>
        </header>

        {posts.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-white/65">{t('noPostsWithTag')}</p>
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
