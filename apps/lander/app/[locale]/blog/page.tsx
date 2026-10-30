import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'

import { CategoryFilter } from '@/components/blog/category-filter'
import { PostCard } from '@/components/blog/post-card'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFinalCta } from '@/components/landing/landing-final-cta'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { getAllPosts } from '@/lib/blog/content'
import { generateBlogListingJsonLd } from '@/lib/blog/seo'
import type { AppLocale } from '@/lib/i18n/locales'
import { buildLocalizedMetadata } from '@/lib/i18n/metadata'
import { listingCopy } from '@/lib/i18n/page-copy'

type Props = { params: Promise<{ locale: AppLocale }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params
  const copy = listingCopy.blog[locale]
  return buildLocalizedMetadata({
    locale,
    path: '/blog',
    title: copy.title,
    description: copy.description,
  })
}

export default async function BlogPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = listingCopy.blog[locale]
  const posts = getAllPosts(locale)
  const featuredPost = posts[0]
  const remainingPosts = posts.slice(1)
  const jsonLd = generateBlogListingJsonLd(locale)

  return (
    <LandingChrome noAmbient>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingNav sticky />

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 md:pt-24">
        <SectionReveal className="mb-12">
          <RevealItem>
            <p className="mb-5 text-[11px] uppercase tracking-[0.3em] text-white/55">
              {copy.headingEyebrow}
            </p>
          </RevealItem>
          <RevealItem>
            <h1
              className="mb-5 text-5xl font-normal leading-[1] tracking-[-1.5px] text-white md:text-7xl"
              style={serifStyle}
            >
              {copy.headingLead} <em className="not-italic text-white/70">{copy.headingTrail}</em>
            </h1>
          </RevealItem>
          <RevealItem>
            <p className="max-w-2xl text-lg leading-relaxed text-white/75">{copy.body}</p>
          </RevealItem>
        </SectionReveal>

        <div className="mb-12">
          <CategoryFilter />
        </div>

        {posts.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-white/65">{copy.empty}</p>
          </div>
        ) : (
          <div className="space-y-16">
            {featuredPost && <PostCard post={featuredPost} variant="featured" />}
            {remainingPosts.length > 0 && (
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {remainingPosts.map(post => (
                  <PostCard key={post.slug} post={post} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <LandingFinalCta
        serifStyle={serifStyle}
        headingLead={copy.ctaLead}
        headingTrail={copy.ctaTrail}
        description={copy.ctaDescription}
        primaryLabel={copy.primary}
        secondary={{ label: copy.secondary, href: '/guides' }}
      />
      <LandingFooter />
    </LandingChrome>
  )
}
