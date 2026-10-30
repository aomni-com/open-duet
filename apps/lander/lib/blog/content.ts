import fs from 'fs'
import path from 'path'

import matter from 'gray-matter'
import readingTime from 'reading-time'

import { defaultLocale, locales, type AppLocale } from '@/lib/i18n/locales'

import { extractHeadings } from './toc'
import {
  PostFrontmatterZod,
  type CategorySlug,
  type Post,
  type RelatedItem,
  type RelatedRef,
} from './types'

const CONTENT_DIR = path.join(process.cwd(), 'content')

function formatReadingTime(content: string, locale: AppLocale): string {
  const stats = readingTime(content)
  if (locale === 'es-419') {
    return `${Math.max(1, Math.ceil(stats.minutes))} min de lectura`
  }
  return stats.text
}

function readPostsFromExactDirectory(directory: string, locale: AppLocale): Post[] {
  const dirPath =
    locale === defaultLocale
      ? path.join(CONTENT_DIR, directory)
      : path.join(CONTENT_DIR, locale, directory)

  if (!fs.existsSync(dirPath)) {
    return []
  }

  return fs
    .readdirSync(dirPath)
    .filter(f => f.endsWith('.mdx'))
    .map(filename => {
      const filePath = path.join(dirPath, filename)
      const fileContent = fs.readFileSync(filePath, 'utf8')
      const { data, content } = matter(fileContent)

      const result = PostFrontmatterZod.safeParse(data)
      if (!result.success) {
        console.warn(`Invalid frontmatter in ${filename}:`, result.error)
        return null
      }

      const frontmatter = result.data

      if (frontmatter.draft) return null

      return {
        ...frontmatter,
        slug: filename.replace('.mdx', ''),
        content,
        readingTime: formatReadingTime(content, locale),
        headings: extractHeadings(content),
      }
    })
    .filter((post): post is Post => post !== null)
}

/**
 * Returns the posts for a locale, falling back to the English article when
 * no translation exists for a given slug. We have full English coverage but
 * only a handful of translated Spanish articles, and an empty `/es/blog`
 * reads as broken. So Spanish surfaces list the English bodies with Spanish
 * page chrome; each fallback post keeps its `locale: 'en'` frontmatter, which
 * the blog/guide pages use to (a) point the canonical at the English URL and
 * (b) `noindex` the `/es/...` duplicate — see the style guide rule about not
 * indexing untranslated Spanish duplicates. A real translation dropped into
 * `content/es-419/...` transparently overrides the fallback by slug.
 */
function getPostsFromDirectory(directory: string, locale: AppLocale = defaultLocale): Post[] {
  const sortByDate = (posts: Post[]) =>
    [...posts].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  if (locale === defaultLocale) {
    return sortByDate(readPostsFromExactDirectory(directory, defaultLocale))
  }

  const bySlug = new Map<string, Post>()
  for (const post of readPostsFromExactDirectory(directory, defaultLocale)) {
    bySlug.set(post.slug, post)
  }
  // Real translations override the English fallback by slug.
  for (const post of readPostsFromExactDirectory(directory, locale)) {
    bySlug.set(post.slug, post)
  }
  return sortByDate([...bySlug.values()])
}

export function getAllPosts(locale: AppLocale = defaultLocale): Post[] {
  return getPostsFromDirectory('blog', locale)
}

export function getAllGuides(locale: AppLocale = defaultLocale): Post[] {
  return getPostsFromDirectory('guides', locale)
}

/** True when the given slug has a real translation in `locale` (not a fallback). */
export function hasTranslatedContent(
  directory: 'blog' | 'guides',
  slug: string,
  locale: AppLocale,
): boolean {
  if (locale === defaultLocale) return true
  return fs.existsSync(path.join(CONTENT_DIR, locale, directory, `${slug}.mdx`))
}

export function getPostBySlug(slug: string, locale: AppLocale = defaultLocale): Post | null {
  const posts = getAllPosts(locale)
  return posts.find(p => p.slug === slug) ?? null
}

export function getGuideBySlug(slug: string, locale: AppLocale = defaultLocale): Post | null {
  const guides = getAllGuides(locale)
  return guides.find(g => g.slug === slug) ?? null
}

export function getPostsByCategory(
  category: CategorySlug,
  locale: AppLocale = defaultLocale,
): Post[] {
  const posts = getAllPosts(locale)
  return posts.filter(p => p.category === category)
}

export function getPostsByTag(tag: string, locale: AppLocale = defaultLocale): Post[] {
  const posts = getAllPosts(locale)
  return posts.filter(p => p.tags.includes(tag))
}

export function getAllTags(locale: AppLocale = defaultLocale): string[] {
  const posts = getAllPosts(locale)
  const tags = new Set(posts.flatMap(p => p.tags))
  return Array.from(tags).sort()
}

function normalizeRelatedRef(ref: RelatedRef): { slug: string; context?: string } {
  return typeof ref === 'string' ? { slug: ref } : ref
}

function pickRelated(source: Post, pool: Post[], limit: number): RelatedItem[] {
  const candidates = pool.filter(p => p.slug !== source.slug)
  const picked: RelatedItem[] = []
  const seen = new Set<string>()

  // 1. Honor explicit frontmatter refs (in author-specified order)
  if (source.relatedPosts?.length) {
    for (const ref of source.relatedPosts) {
      if (picked.length >= limit) break
      const { slug, context } = normalizeRelatedRef(ref)
      const match = candidates.find(p => p.slug === slug)
      if (match && !seen.has(match.slug)) {
        picked.push({ ...match, relatedContext: context })
        seen.add(match.slug)
      }
    }
  }

  // 2. Fill remaining slots with algorithmic matches
  if (picked.length < limit) {
    const ranked = candidates
      .filter(p => !seen.has(p.slug))
      .map(p => ({ post: p, score: calculateRelevanceScore(source, p) }))
      .sort((a, b) => b.score - a.score)

    for (const { post } of ranked) {
      if (picked.length >= limit) break
      picked.push(post)
      seen.add(post.slug)
    }
  }

  return picked
}

// Combined pool: blog posts + guides. Both surfaces share the same algorithm so a
// blog post can recommend guides and vice versa. Type-match still wins via scoring.
function getCombinedPool(locale: AppLocale = defaultLocale): Post[] {
  return [...getAllPosts(locale), ...getAllGuides(locale)]
}

export function getRelatedPosts(post: Post, limit = 6): RelatedItem[] {
  return pickRelated(post, getCombinedPool(post.locale), limit)
}

export function getRelatedGuides(guide: Post, limit = 6): RelatedItem[] {
  return pickRelated(guide, getCombinedPool(guide.locale), limit)
}

export function getTranslatedLocalesForPost(
  directory: 'blog' | 'guides',
  slug: string,
): AppLocale[] {
  return locales.filter(locale => {
    const filePath =
      locale === defaultLocale
        ? path.join(CONTENT_DIR, directory, `${slug}.mdx`)
        : path.join(CONTENT_DIR, locale, directory, `${slug}.mdx`)
    return fs.existsSync(filePath)
  })
}

function calculateRelevanceScore(source: Post, candidate: Post): number {
  let score = 0

  // Same content type (blog↔blog, guide↔guide) ranks above cross-type matches
  // so the surface still feels coherent while still allowing cross-recommendations.
  if (source.type === candidate.type) score += 2

  if (source.category === candidate.category) score += 3

  const sharedTags = source.tags.filter(t => candidate.tags.includes(t))
  score += sharedTags.length

  // Editorial nudge: pages flagged for boost get extra ranking weight in
  // algorithmic fill (e.g. under-indexed pages we want to push crawl signal to).
  if (candidate.boostRelated) score += 2

  return score
}
