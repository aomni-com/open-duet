'use client'

import { List } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { useState } from 'react'

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/shadcn/sheet'
import { cn } from '@repo/ui/lib/utils'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { SecondaryButton } from '@/components/landing/landing-cta'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import type { Post, RelatedItem } from '@/lib/blog/types'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

import { ArticleWithCTA } from './article-with-cta'
import { FloatingEmailCapture } from './floating-email-capture'
import { RelatedSection } from './related-section'
import { SocialShare } from './social-share'
import { ThemedImage } from './themed-image'
import { TocSidebar } from './toc-sidebar'
import { TrailingCta } from './trailing-cta'

type GuideLayoutProps = {
  post: Post
  slug: string
  children: React.ReactNode
  relatedGuides?: RelatedItem[]
}

function dateLocaleFor(locale: Post['locale']): string {
  return locale === 'es-419' ? 'es' : 'en-US'
}

export function GuideLayout({ post, slug, children, relatedGuides }: GuideLayoutProps) {
  const t = useTranslations('blogUi')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const shareUrl =
    post.locale === 'es-419'
      ? `${LANDER_ORIGIN}/es/guides/${slug}`
      : `${LANDER_ORIGIN}/guides/${slug}`

  return (
    <LandingChrome noAmbient>
      <LandingNav sticky />

      <div className="border-b border-white/[0.06]">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="mb-5 text-[11px] uppercase tracking-[0.3em] text-white/55">
            {t('guideLabel')}
          </p>
          <h1
            className="mb-10 max-w-3xl text-4xl font-normal leading-[1.05] tracking-[-1px] text-white sm:text-6xl"
            style={serifStyle}
          >
            {post.title}
          </h1>

          {/* Author */}
          <div className="mb-8 flex items-center gap-4">
            {post.author.avatar && (
              <Image
                src={post.author.avatar}
                alt={post.author.name}
                width={44}
                height={44}
                className="rounded-full ring-2 ring-white/10"
              />
            )}
            {post.author.link ? (
              <a
                href={post.author.link}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-white transition-colors hover:text-white/80"
              >
                {post.author.name}
              </a>
            ) : (
              <p className="font-medium text-white">{post.author.name}</p>
            )}
          </div>

          {/* Metadata + share */}
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3 text-sm text-white/65">
              <span>{post.readingTime}</span>
              <span className="text-white/30">·</span>
              <time>
                {t('updated')}{' '}
                {new Date(post.updatedAt ?? post.date).toLocaleDateString(
                  dateLocaleFor(post.locale),
                  {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  },
                )}
              </time>
            </div>
            <div className="flex items-center gap-2">
              <SocialShare title={post.title} url={shareUrl} content={post.content} />
              <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
                <SheetTrigger asChild>
                  <SecondaryButton size="sm" className="lg:hidden">
                    <List className="h-4 w-4" />
                    {t('contents')}
                  </SecondaryButton>
                </SheetTrigger>
                <SheetContent side="left" className="bg-lv2-surface w-80 border border-lv2-line">
                  <SheetHeader>
                    <SheetTitle className="text-white">{t('tableOfContents')}</SheetTitle>
                  </SheetHeader>
                  <div className="mt-6">
                    <TocSidebar headings={post.headings} />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex gap-10 py-10">
          <aside
            className={cn(
              'hidden w-64 shrink-0 lg:block',
              'sticky top-24 h-[calc(100vh-8rem)] overflow-y-auto',
              'border-r border-white/[0.06] pr-4',
            )}
          >
            <TocSidebar headings={post.headings} />
          </aside>

          <main className="min-w-0 flex-1">
            {post.image && (
              <div className="relative mb-12 aspect-video overflow-hidden rounded-2xl border border-white/10">
                <ThemedImage
                  src={post.image}
                  alt={post.title}
                  fill
                  className="object-cover"
                  priority
                />
              </div>
            )}
            <ArticleWithCTA cta={post.cta}>{children}</ArticleWithCTA>
          </main>
        </div>
      </div>

      <TrailingCta />

      {relatedGuides && <RelatedSection title={t('relatedGuides')} items={relatedGuides} />}

      <FloatingEmailCapture source="guide" pageSlug={slug} layout="guide" />

      <LandingFooter />
    </LandingChrome>
  )
}
