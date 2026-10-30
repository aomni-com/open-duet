import { useTranslations } from 'next-intl'
import Image from 'next/image'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@repo/ui/components/shadcn/breadcrumb'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { Link } from '@/i18n/navigation'
import { getCategoryName } from '@/lib/blog/categories'
import type { Post, RelatedItem } from '@/lib/blog/types'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

import { ArticleWithCTA } from './article-with-cta'
import { FloatingEmailCapture } from './floating-email-capture'
import { RelatedSection } from './related-section'
import { SocialShare } from './social-share'
import { ThemedImage } from './themed-image'
import { TrailingCta } from './trailing-cta'

type BlogLayoutProps = {
  post: Post
  slug: string
  children: React.ReactNode
  relatedPosts?: RelatedItem[]
}

function dateLocaleFor(locale: Post['locale']): string {
  return locale === 'es-419' ? 'es' : 'en-US'
}

export function BlogLayout({ post, slug, children, relatedPosts }: BlogLayoutProps) {
  const t = useTranslations('blogUi')
  const categoryName = getCategoryName(post.category, post.locale)
  const shareUrl =
    post.locale === 'es-419' ? `${LANDER_ORIGIN}/es/blog/${slug}` : `${LANDER_ORIGIN}/blog/${slug}`

  return (
    <LandingChrome noAmbient>
      <LandingNav sticky />

      <div className="border-b border-white/[0.06] py-3">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild className="text-white/55 hover:text-white">
                  <Link href="/blog">{t('blog')}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="text-white/30" />
              <BreadcrumbItem>
                <BreadcrumbLink asChild className="text-white/55 hover:text-white">
                  <Link href={`/blog/category/${post.category}`}>{categoryName}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="text-white/30" />
              <BreadcrumbItem>
                <BreadcrumbPage className="max-w-[200px] truncate text-white/80">
                  {post.title}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <article className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[hsl(214_65%_50%/0.3)] bg-[hsl(214_65%_50%/0.12)] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[hsl(214_65%_50%)]">
              {categoryName}
            </span>
            {post.tags.slice(0, 3).map(tag => (
              <Link
                key={tag}
                href={`/blog/tag/${encodeURIComponent(tag)}`}
                className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-white/65 transition-colors hover:border-white/20 hover:text-white"
              >
                {tag}
              </Link>
            ))}
          </div>

          <h1
            className="mb-5 text-4xl font-normal leading-[1.03] tracking-[-1px] text-white md:text-6xl"
            style={serifStyle}
          >
            {post.title}
          </h1>
          <p className="mb-8 max-w-3xl text-lg leading-relaxed text-white/75 md:text-xl">
            {post.description}
          </p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-3">
              {post.author.avatar && (
                <Image
                  src={post.author.avatar}
                  alt={post.author.name}
                  width={36}
                  height={36}
                  className="rounded-full ring-2 ring-white/10"
                />
              )}
              <div>
                {post.author.link ? (
                  <a
                    href={post.author.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-white transition-colors hover:text-white/80"
                  >
                    {post.author.name}
                  </a>
                ) : (
                  <p className="text-sm font-medium text-white">{post.author.name}</p>
                )}
                {post.author.role && <p className="text-xs text-white/55">{post.author.role}</p>}
              </div>
            </div>
            <span className="text-white/30">·</span>
            <time className="text-sm text-white/65">
              {new Date(post.date).toLocaleDateString(dateLocaleFor(post.locale), {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </time>
            <span className="text-white/30">·</span>
            <span className="text-sm text-white/65">{post.readingTime}</span>
            <span className="text-white/30">·</span>
            <SocialShare title={post.title} url={shareUrl} content={post.content} />
          </div>
        </header>

        {post.image && (
          <div className="relative mb-12 aspect-video overflow-hidden rounded-2xl border border-white/10">
            <ThemedImage src={post.image} alt={post.title} fill className="object-cover" priority />
          </div>
        )}

        <ArticleWithCTA cta={post.cta}>{children}</ArticleWithCTA>
      </article>

      <TrailingCta />

      {relatedPosts && <RelatedSection title={t('relatedArticles')} items={relatedPosts} />}

      <FloatingEmailCapture source="blog" pageSlug={slug} layout="blog" />

      <LandingFooter />
    </LandingChrome>
  )
}
