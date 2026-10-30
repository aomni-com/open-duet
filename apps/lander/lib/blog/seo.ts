import type { AppLocale } from '@/lib/i18n/locales'
import { localeMetadata, localizePath } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'

import type { Post } from './types'

const BASE_URL = `${LANDER_ORIGIN}`

const PERSON_AUTHORS = new Set(['Sawyer Middeleer', 'David'])

/** Ensure a date string includes time and timezone for schema.org compliance. */
function toIsoDateTime(date: string): string {
  if (date.includes('T')) return date
  return `${date}T00:00:00Z`
}

function buildAuthor(name: string) {
  if (PERSON_AUTHORS.has(name)) {
    return { '@type': 'Person' as const, name, url: BASE_URL }
  }
  return { '@type': 'Organization' as const, name, url: BASE_URL }
}

export function generateBlogPostingJsonLd(post: Post, locale: AppLocale = post.locale) {
  const url = `${BASE_URL}${localizePath(`/blog/${post.slug}`, locale)}`
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    inLanguage: localeMetadata[locale].htmlLang,
    headline: post.title,
    description: post.description,
    url,
    image: post.image ? `${BASE_URL}${post.image}` : `${BASE_URL}/blog/${post.slug}/cover.png`,
    datePublished: toIsoDateTime(post.date),
    dateModified: toIsoDateTime(post.updatedAt ?? post.date),
    author: buildAuthor(post.author.name),
    publisher: {
      '@type': 'Organization',
      name: 'Duet',
      url: BASE_URL,
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/landing/icons/eclipse-white.svg`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': url,
    },
  }
}

export function generateGuideJsonLd(post: Post, locale: AppLocale = post.locale) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    inLanguage: localeMetadata[locale].htmlLang,
    headline: post.title,
    description: post.description,
    image: post.image ? `${BASE_URL}${post.image}` : `${BASE_URL}/guides/${post.slug}/cover.png`,
    datePublished: toIsoDateTime(post.date),
    dateModified: toIsoDateTime(post.updatedAt ?? post.date),
    author: {
      '@type': 'Organization',
      name: 'Duet',
      url: BASE_URL,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Duet',
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/landing/icons/eclipse-white.svg`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${BASE_URL}${localizePath(`/guides/${post.slug}`, locale)}`,
    },
  }
}

export function generateBreadcrumbJsonLd(
  items: Array<{ name: string; url: string }>,
  locale: AppLocale = 'en',
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${BASE_URL}${localizePath(item.url, locale)}`,
    })),
  }
}

export function generateFaqJsonLd(items: Array<{ question: string; answer: string }>) {
  if (items.length === 0) return null

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\[(.*?)\]\((?:.*?)\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract FAQ items from MDX content. Supports two patterns:
 *
 * 1. <AccordionTrigger>Q</AccordionTrigger><AccordionContent>A</AccordionContent>
 * 2. A `## Frequently Asked Questions` (or `## FAQ`) section followed by
 *    `### Question?` headings, each with a markdown answer underneath.
 *
 * Returns an array of {question, answer} pairs.
 */
export function extractFaqFromContent(
  content: string,
): Array<{ question: string; answer: string }> {
  const items: Array<{ question: string; answer: string }> = []

  const accordionRegex =
    /<AccordionTrigger>([\s\S]*?)<\/AccordionTrigger>\s*<AccordionContent>\s*([\s\S]*?)\s*<\/AccordionContent>/g
  let match
  while ((match = accordionRegex.exec(content)) !== null) {
    const question = match[1]?.trim()
    const answer = match[2] ? stripMarkdown(match[2]) : ''
    if (question && answer) {
      items.push({ question, answer })
    }
  }

  const faqSection = sliceFaqSection(content)
  if (faqSection) {
    // ### Question / answer paragraphs / next ### or section end
    const headingQaRegex = /^###\s+(.+?)\s*$([\s\S]*?)(?=^###\s+|$(?![\s\S]))/gm
    let qaMatch
    while ((qaMatch = headingQaRegex.exec(faqSection)) !== null) {
      const question = qaMatch[1]?.trim()
      const answer = qaMatch[2] ? stripMarkdown(qaMatch[2]) : ''
      if (question && answer) {
        items.push({ question, answer })
      }
    }

    if (items.length === 0) {
      // Fallback: bold standalone questions like **What is X?** followed by paragraph
      const boldQaRegex = /^\*\*(.+?\?)\*\*\s*$([\s\S]*?)(?=^\*\*.+?\?\*\*\s*$|$(?![\s\S]))/gm
      while ((qaMatch = boldQaRegex.exec(faqSection)) !== null) {
        const question = qaMatch[1]?.trim()
        const answer = qaMatch[2] ? stripMarkdown(qaMatch[2]) : ''
        if (question && answer) {
          items.push({ question, answer })
        }
      }
    }
  }

  return items
}

function sliceFaqSection(content: string): string | null {
  const headingRegex =
    /^##\s+(?:Frequently\s+Asked\s+Questions|FAQs?|Common\s+Questions(?:\s+and\s+Answers)?)\b.*$/im
  const match = content.match(headingRegex)
  if (!match || match.index === undefined) return null
  const start = match.index + match[0].length
  const rest = content.slice(start)
  const nextH2 = rest.match(/^##\s+/m)
  return nextH2 && nextH2.index !== undefined ? rest.slice(0, nextH2.index) : rest
}

export function generateHowToJsonLd(howTo: {
  name: string
  description: string
  steps: Array<{ name: string; text: string }>
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: howTo.name,
    description: howTo.description,
    step: howTo.steps.map((step, index) => ({
      '@type': 'HowToStep',
      name: step.name,
      text: step.text,
      position: index + 1,
    })),
  }
}

export function generateGuidesCollectionJsonLd(guides: Post[], locale: AppLocale = 'en') {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Claude Code & AI Agent Guides',
    description:
      'Practical guides for Claude Code, MCP, agent skills, and agentic workflows. From beginner setup to running your entire business with AI.',
    url: `${BASE_URL}${localizePath('/guides', locale)}`,
    hasPart: guides.map(guide => ({
      '@type': 'Article',
      name: guide.title,
      url: `${BASE_URL}${localizePath(`/guides/${guide.slug}`, locale)}`,
    })),
    publisher: {
      '@type': 'Organization',
      name: 'Duet',
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/landing/icons/eclipse-white.svg`,
      },
    },
  }
}

export function generateBlogListingJsonLd(locale: AppLocale = 'en') {
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Duet Blog',
    description: 'Insights on AI-powered team collaboration and productivity',
    url: `${BASE_URL}${localizePath('/blog', locale)}`,
    publisher: {
      '@type': 'Organization',
      name: 'Duet',
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/landing/icons/eclipse-white.svg`,
      },
    },
  }
}
