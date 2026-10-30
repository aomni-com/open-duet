import type { Metadata } from 'next'
import { setRequestLocale } from 'next-intl/server'
import { MDXRemote } from 'next-mdx-remote/rsc'
import { notFound } from 'next/navigation'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'

import { BlogLayout } from '@/components/blog/blog-layout'
import { mdxComponents } from '@/components/blog/mdx-components'
import {
  getAllPosts,
  getPostBySlug,
  getRelatedPosts,
  getTranslatedLocalesForPost,
  hasTranslatedContent,
} from '@/lib/blog/content'
import {
  extractFaqFromContent,
  generateBlogPostingJsonLd,
  generateBreadcrumbJsonLd,
  generateFaqJsonLd,
} from '@/lib/blog/seo'
import {
  isEsHreflangSuppressedSlug,
  isNoindexedEsEditorialSlug,
} from '@/lib/i18n/es-editorial-indexing'
import { localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { localizedCanonical } from '@/lib/i18n/metadata'

type Props = { params: Promise<{ locale: AppLocale; slug: string }> }

export async function generateStaticParams() {
  return getAllPosts().flatMap(post =>
    getTranslatedLocalesForPost('blog', post.slug).map(locale => ({ locale, slug: post.slug })),
  )
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params
  const post = getPostBySlug(slug, locale)
  if (!post) return {}

  const ogImage = post.image ?? `/blog/${slug}/cover.png`
  // When the page is an English fallback served under a non-default locale,
  // point the canonical at the real (English) URL and noindex the duplicate
  // so search engines only index the canonical version.
  const isFallback = !hasTranslatedContent('blog', slug, locale)
  const url = isFallback
    ? localizedCanonical(`/blog/${slug}`, 'en')
    : localizedCanonical(`/blog/${slug}`, locale)
  const translatedLocales = getTranslatedLocalesForPost('blog', slug)
  // Bucket B/C `/es` posts: drop the `es` hreflang from the cluster so the EN
  // original never advertises a redirected/noindexed alternate.
  const hreflangLocales = isEsHreflangSuppressedSlug('blog', slug)
    ? translatedLocales.filter(l => l === 'en')
    : translatedLocales
  // Bucket C: noindex only the es-419 variant — the EN original stays indexed.
  const isNoindexEs = locale === 'es-419' && isNoindexedEsEditorialSlug('blog', slug)
  const pageTitle = post.metaTitle ?? `${post.title} | Duet Blog`
  const socialTitle = post.metaTitle ?? post.title

  return {
    title: pageTitle,
    description: post.description,
    authors: [{ name: post.author.name }],
    robots: isFallback || isNoindexEs ? { index: false, follow: true } : undefined,
    openGraph: {
      title: socialTitle,
      description: post.description,
      type: 'article',
      publishedTime: post.date,
      modifiedTime: post.updatedAt,
      authors: [post.author.name],
      images: [{ url: ogImage, width: 1200, height: 630, alt: post.title }],
      url,
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description: post.description,
      images: [ogImage],
    },
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(
          hreflangLocales.map(l => [
            localeMetadata[l].hreflang,
            localizedCanonical(`/blog/${slug}`, l),
          ]),
        ),
        'x-default': localizedCanonical(`/blog/${slug}`, 'en'),
      },
    },
  }
}

export default async function BlogPostPage({ params }: Props) {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const post = getPostBySlug(slug, locale)
  if (!post) notFound()

  const relatedPosts = getRelatedPosts(post, 3)
  const articleJsonLd = generateBlogPostingJsonLd(post, locale)
  const breadcrumbJsonLd = generateBreadcrumbJsonLd(
    [
      { name: 'Blog', url: '/blog' },
      { name: post.category, url: `/blog/category/${post.category}` },
      { name: post.title, url: `/blog/${slug}` },
    ],
    locale,
  )
  const faqJsonLd = generateFaqJsonLd(extractFaqFromContent(post.content))

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
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
      <BlogLayout post={post} slug={slug} relatedPosts={relatedPosts}>
        <MDXRemote
          source={post.content}
          components={mdxComponents}
          options={{ mdxOptions: { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] } }}
        />
      </BlogLayout>
    </>
  )
}
