import { VERTICALS } from '@/components/landing/for/verticals-spec'
import {
  getUseCaseJob,
  getUseCaseLeaf,
  getUseCasePersona,
  type UseCasePersona,
  type UseCasePersonaLeaf,
  type UseCaseJob,
} from '@/components/landing/use-cases/use-cases-spec'
import { getComparison } from '@/components/landing/vs/vs-spec'
import { getAllGuides, getAllPosts } from '@/lib/blog/content'
import type { Post } from '@/lib/blog/types'

import { bullets, faqSection, heading, section, steps, stripBrandSuffix } from './markdown'
import { mdxToMarkdown } from './mdx-to-markdown'
import { getLlmsRoutes, type LlmsRoute } from './routes'
import { STATIC_PAGES } from './static-pages'

export type LlmsPage = {
  path: string
  title: string
  description: string
  /** Complete page body, opening with its own `# ` heading. */
  markdown: string
}

/**
 * Memoised for the same reason `sitemap-shards.ts` memoises its disk walk:
 * three surfaces (the index, the full text, and every twin's
 * `generateStaticParams`) each ask for the whole corpus during one build, and
 * rendering it means parsing every MDX file in `content/`.
 */
let pagesCache: LlmsPage[] | undefined
export async function getLlmsPages(): Promise<LlmsPage[]> {
  pagesCache ??= (await getLlmsRoutes()).map(render)
  return pagesCache
}

export async function getLlmsPage(path: string): Promise<LlmsPage | null> {
  return (await getLlmsPages()).find(page => page.path === path) ?? null
}

/**
 * Every page is rendered from the same source the page itself renders from —
 * the MDX file, the landing spec, the copy module. Nothing here reads built
 * HTML, so a twin cannot drift into being a worse copy of the page: if the
 * spec changes, both move together.
 */
function render(route: LlmsRoute): LlmsPage {
  switch (route.kind) {
    case 'editorial':
      return renderEditorial(route.path)
    case 'vertical':
      return renderVertical(route.path)
    case 'use-case':
      return renderUseCase(route.path)
    case 'comparison':
      return renderComparison(route.path)
    case 'overview':
    case 'marketing':
      return renderStatic(route.path)
  }
}

function renderStatic(path: string): LlmsPage {
  const page = STATIC_PAGES[path]
  if (page === undefined) {
    throw new Error(`No llms.txt copy owner for ${path} — add it to STATIC_PAGES`)
  }
  const title = stripBrandSuffix(page.title)
  const body = page.body()
  // `/install` reuses `agentInstallText`, which is already a document with its
  // own H1. Prepending another one gives the twin two titles.
  const markdown = body.startsWith('# ') ? body : `${heading(title)}\n\n${body}`
  return { path, title, description: page.description, markdown }
}

/**
 * Memoised because `getPostBySlug` re-reads and re-parses the whole content
 * directory per call. Rendering ninety-odd articles that way is a hundred
 * thousand file reads; the same reason `sitemap-shards.ts` caches its disk
 * walk.
 */
let editorialCache: Map<string, Post> | undefined
function editorialBySlug(): Map<string, Post> {
  editorialCache ??= new Map([
    ...getAllPosts('en').map(post => [`/blog/${post.slug}`, post] as const),
    ...getAllGuides('en').map(guide => [`/guides/${guide.slug}`, guide] as const),
  ])
  return editorialCache
}

function renderEditorial(path: string): LlmsPage {
  const post = editorialBySlug().get(path)
  if (post === undefined) throw new Error(`No editorial content for ${path}`)
  return {
    path,
    title: post.title,
    description: post.description,
    markdown: [heading(post.title), byline(post), mdxToMarkdown(post.content)].join('\n\n'),
  }
}

function byline(post: Post): string {
  const updated = post.updatedAt === undefined ? '' : `, updated ${post.updatedAt}`
  return `*${post.description}*\n\nBy ${post.author.name}. Published ${post.date}${updated}. ${post.readingTime}.`
}

function renderVertical(path: string): LlmsPage {
  const slug = path.replace('/for/', '')
  const vertical = VERTICALS.find(candidate => candidate.slug === slug)
  if (vertical === undefined) throw new Error(`No vertical spec for ${path}`)
  return {
    path,
    title: `${vertical.heroLead} ${vertical.heroHighlight}`,
    description: vertical.metaDescription,
    markdown: [
      heading(`Duet for ${vertical.audience.toLowerCase()}`),
      vertical.heroSubhead,
      section(
        'What it does',
        vertical.outcomes
          .map(outcome => `${heading(outcome.title, 3)}\n\n${outcome.body}`)
          .join('\n\n'),
      ),
      section('A day-one prompt', `> ${vertical.kickoffPrompt}`),
      faqSection('FAQ', vertical.faqs),
    ].join('\n\n'),
  }
}

function renderComparison(path: string): LlmsPage {
  const slug = path.replace('/vs/', '')
  const comparison = getComparison(slug)
  if (comparison === undefined) throw new Error(`No comparison spec for ${path}`)
  return {
    path,
    title: comparison.h1,
    description: comparison.metaDescription,
    markdown: [
      heading(comparison.h1),
      `${comparison.verdict.tldr}\n\n*Updated ${comparison.lastUpdated} — ${comparison.lastChanged}*`,
      section(
        `Where ${comparison.competitor} wins`,
        comparison.whereCompetitorWins
          .map(win => `${heading(win.heading, 3)}\n\n${win.body}`)
          .join('\n\n'),
      ),
      section(
        'Where Duet wins',
        comparison.whereDuetWins
          .map(win => `${heading(win.heading, 3)}\n\n${win.body}`)
          .join('\n\n'),
      ),
      faqSection('FAQ', comparison.faqs),
    ].join('\n\n'),
  }
}

function renderUseCase(path: string): LlmsPage {
  const [head = '', tail] = path.replace('/use-cases/', '').split('/')
  if (head === 'by-job') {
    const job = tail === undefined ? undefined : getUseCaseJob(tail)
    if (job === undefined) throw new Error(`No by-job spec for ${path}`)
    return renderJob(path, job)
  }
  if (tail === undefined) {
    const persona = getUseCasePersona(head)
    if (persona === undefined) throw new Error(`No persona spec for ${path}`)
    return renderPersona(path, persona)
  }
  const found = getUseCaseLeaf(head, tail)
  if (found === undefined) throw new Error(`No use-case leaf spec for ${path}`)
  return renderLeaf(path, found.leaf)
}

function renderPersona(path: string, persona: UseCasePersona): LlmsPage {
  return {
    path,
    title: `Duet for ${persona.name.toLowerCase()}`,
    description: persona.metaDescription,
    markdown: [
      heading(`Duet for ${persona.name.toLowerCase()}`),
      persona.heroDescription,
      ...(persona.definition === undefined ? [] : [persona.definition]),
      section(
        'What it does',
        persona.useCases
          .map(useCase =>
            [
              heading(useCase.title, 3),
              `Ask it: "${useCase.prompt}"`,
              `Outcome: ${useCase.outcome}`,
            ].join('\n\n'),
          )
          .join('\n\n'),
      ),
      section(
        'The problems it picks up',
        persona.painCards
          .map(card => [heading(card.title, 3), `"${card.quote}"`, card.body].join('\n\n'))
          .join('\n\n'),
      ),
      section(
        'Before and after',
        [
          `${heading('Without Duet', 3)}\n\n${bullets(persona.comparison.without)}`,
          `${heading('With Duet', 3)}\n\n${bullets(persona.comparison.with)}`,
        ].join('\n\n'),
      ),
      section('How it works', steps(persona.howItWorks)),
      faqSection('FAQ', persona.faqs),
    ].join('\n\n'),
  }
}

function renderLeaf(path: string, leaf: UseCasePersonaLeaf): LlmsPage {
  return {
    path,
    title: leaf.h1,
    description: leaf.metaDescription,
    markdown: [
      heading(leaf.h1),
      leaf.intro,
      section('The workflow', steps(leaf.workflowSteps)),
      faqSection('FAQ', leaf.faqs),
    ].join('\n\n'),
  }
}

function renderJob(path: string, job: UseCaseJob): LlmsPage {
  return {
    path,
    title: job.h1,
    description: job.metaDescription,
    markdown: [
      heading(job.h1),
      job.intro,
      section('The workflow', steps(job.jobSteps)),
      faqSection('FAQ', job.faqs),
    ].join('\n\n'),
  }
}
