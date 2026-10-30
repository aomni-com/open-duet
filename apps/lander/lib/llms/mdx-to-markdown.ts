import { productHref } from '@/src/config/origins'

/**
 * MDX bodies are markdown with a handful of React components mixed in. An
 * agent-readable twin has to be plain markdown, so each component is either
 * chrome (drop it) or a wrapper around real prose (unwrap it) — never left
 * as a raw tag, which reads to a model as broken markup.
 *
 * `mdx-to-markdown.test.ts` asserts over every shipped post that nothing
 * capitalised-tag-shaped survives, so a new component in a post fails the
 * package test until it is classified here.
 */

/** Presentational only: a table of contents, a CTA card, an embed. */
const CHROME = [
  'GuideTOC',
  'DuetCTA',
  'ResourcesCTA',
  'HeroImage',
  'YouTubeEmbed',
  'Video',
  'LinkedInPostPreview',
] as const

/** Containers whose children are the actual article prose. */
const UNWRAPPED = ['Callout', 'Accordion', 'AccordionItem', 'AccordionContent'] as const

export function mdxToMarkdown(mdx: string): string {
  const lifted = liftComponents(mdx)
  return normalizeBlankLines(unwrapContainers(lifted))
}

/** Replace components with the markdown that carries their meaning. */
function liftComponents(mdx: string): string {
  return (
    mdx
      // An answer box is a summary card: its `title` and `summary` props are
      // the prose, the query/bullet arrays are SEO metadata.
      .replace(/<AnswerBox\b([\s\S]*?)\/>/g, (_match, props: string) => {
        const title = jsxStringProp(props, 'title')
        const summary = jsxStringProp(props, 'summary')
        return [title === null ? null : `**${title}**`, summary].filter(Boolean).join('\n\n')
      })
      .replace(new RegExp(`<(?:${CHROME.join('|')})\\b[\\s\\S]*?/>`, 'g'), '')
      // The trigger is the question of a FAQ pair; the answer follows in the
      // AccordionContent that gets unwrapped below.
      .replace(
        /<AccordionTrigger>([\s\S]*?)<\/AccordionTrigger>/g,
        (_match, question: string) => `**${collapseWhitespace(question)}**`,
      )
      .replace(
        /<ProductLink\b([^>]*)>([\s\S]*?)<\/ProductLink>/g,
        (match, props: string, text: string) => {
          const path = jsxStringProp(props, 'path')
          if (path === null) return match
          return `[${collapseWhitespace(text)}](${productHref(path)})`
        },
      )
      // A container written inline (`<Callout emoji="❓">text</Callout>`) never
      // reaches the line-based unwrap below, which only knows lone tag lines.
      .replace(
        new RegExp(`<(${UNWRAPPED.join('|')})\\b[^>]*>(.*?)</\\1>`, 'g'),
        (_match, _tag: string, inner: string) => inner,
      )
  )
}

/**
 * Drop container tag lines and de-indent what they wrapped. Accordion bodies
 * are indented four to six spaces for readability in the source; left alone
 * markdown would render them as code blocks.
 *
 * A removed tag becomes a blank line rather than nothing, so the prose either
 * side of it stays two separate blocks instead of merging into one paragraph.
 */
function unwrapContainers(mdx: string): string {
  const openers = new RegExp(`^<(?:${UNWRAPPED.join('|')})\\b[^>]*>$`)
  const closers = new RegExp(`^</(?:${UNWRAPPED.join('|')})>$`)

  const lines: Array<{ text: string; wrapped: boolean }> = []
  let depth = 0
  for (const line of mdx.split('\n')) {
    const trimmed = line.trim()
    if (openers.test(trimmed)) {
      depth += 1
      lines.push({ text: '', wrapped: false })
    } else if (closers.test(trimmed)) {
      depth = Math.max(0, depth - 1)
      lines.push({ text: '', wrapped: false })
    } else {
      lines.push({ text: line, wrapped: depth > 0 })
    }
  }
  return dedentWrappedRuns(lines).join('\n')
}

/**
 * De-indent each contiguous run of wrapped, non-blank lines by the run's own
 * minimum indent, so relative indentation inside a run (nested lists, fenced
 * code) survives while the wrapper's indentation does not.
 */
function dedentWrappedRuns(lines: Array<{ text: string; wrapped: boolean }>): string[] {
  const output = lines.map(line => line.text)
  let runStart: number | null = null

  const flush = (end: number) => {
    if (runStart === null) return
    const run = output.slice(runStart, end)
    const indent = Math.min(...run.map(line => line.length - line.trimStart().length))
    output.splice(runStart, run.length, ...run.map(line => line.slice(indent)))
    runStart = null
  }

  for (const [index, line] of lines.entries()) {
    if (line.wrapped && line.text.trim() !== '') {
      runStart ??= index
    } else {
      flush(index)
    }
  }
  flush(lines.length)
  return output
}

function normalizeBlankLines(markdown: string): string {
  return markdown
    .split('\n')
    .map(line => (line.trim() === '' ? '' : line.trimEnd()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function jsxStringProp(props: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(props)?.[1] ?? null
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
