import type { TocHeading } from './types'

/**
 * Extracts headings from MDX content for table of contents.
 * Uses regex to parse h2 and h3 headings.
 */
export function extractHeadings(content: string): TocHeading[] {
  const headingRegex = /^(#{2,3})\s+(.+)$/gm
  const headings: TocHeading[] = []
  const usedIds = new Set<string>()
  const suffixes = new Map<string, number>()

  let match
  while ((match = headingRegex.exec(content)) !== null) {
    const hashes = match[1]
    const headingText = match[2]
    if (!hashes || !headingText) continue

    const level = hashes.length as 2 | 3
    const text = headingText.trim()
    const id = uniqueSlug(slugify(text), usedIds, suffixes)

    headings.push({ id, text, level })
  }

  return headings
}

/** Allocate duplicate suffixes exactly as GitHub Slugger / rehype-slug do. */
function uniqueSlug(base: string, usedIds: Set<string>, suffixes: Map<string, number>): string {
  let id = base
  let suffix = suffixes.get(base) ?? 0
  while (usedIds.has(id)) {
    suffix += 1
    id = `${base}-${suffix}`
  }
  suffixes.set(base, suffix)
  usedIds.add(id)
  return id
}

/**
 * Creates a URL-safe slug from heading text.
 * Matches the behavior of rehype-slug/github-slugger.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .trim()
}

/**
 * Groups headings into sections (h2 with nested h3s)
 */
export function groupHeadingsBySections(headings: TocHeading[]) {
  const sections: Array<TocHeading & { children: TocHeading[] }> = []
  let currentSection: (TocHeading & { children: TocHeading[] }) | null = null

  for (const heading of headings) {
    if (heading.level === 2) {
      currentSection = { ...heading, children: [] }
      sections.push(currentSection)
    } else if (heading.level === 3 && currentSection) {
      currentSection.children.push(heading)
    }
  }

  return sections
}
