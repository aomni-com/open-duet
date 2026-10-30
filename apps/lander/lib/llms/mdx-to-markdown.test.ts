import { expect, test } from 'bun:test'

import { resolveConfiguredProductOrigin } from '@/src/config/origins'

import { mdxToMarkdown } from './mdx-to-markdown'

test('drops page chrome that carries no prose', () => {
  const output = mdxToMarkdown(
    [
      'Intro line.',
      '',
      '<GuideTOC />',
      '',
      '<DuetCTA',
      '  variant="inline"',
      '/>',
      '',
      'Outro.',
    ].join('\n'),
  )

  expect(output).toBe('Intro line.\n\nOutro.')
})

test('turns an accordion FAQ into question-and-answer prose', () => {
  const output = mdxToMarkdown(
    [
      '<Accordion type="single">',
      '  <AccordionItem value="why-amnesia">',
      '    <AccordionTrigger>Why do people call this "AI amnesia"?</AccordionTrigger>',
      '    <AccordionContent>',
      '      The term started as a meme and stuck because it captures the',
      '      experience precisely.',
      '    </AccordionContent>',
      '  </AccordionItem>',
      '</Accordion>',
    ].join('\n'),
  )

  expect(output).toBe(
    [
      '**Why do people call this "AI amnesia"?**',
      '',
      'The term started as a meme and stuck because it captures the',
      'experience precisely.',
    ].join('\n'),
  )
})

test('unwraps a callout so its markdown survives', () => {
  const output = mdxToMarkdown(
    ['<Callout emoji="💡">', '**Quick Summary**', '', 'This guide covers X.', '</Callout>'].join(
      '\n',
    ),
  )

  expect(output).toBe('**Quick Summary**\n\nThis guide covers X.')
})

test('lifts an answer box title and summary out of its JSX props', () => {
  const output = mdxToMarkdown(
    [
      '<AnswerBox',
      '  title="What is a no-code AI agent?"',
      '  summary="An agent you configure instead of program."',
      "  queries={['no code ai agent']}",
      '/>',
    ].join('\n'),
  )

  expect(output).toBe(
    '**What is a no-code AI agent?**\n\nAn agent you configure instead of program.',
  )
})

test('resolves a product link against the product origin, whatever else it is passed', () => {
  const output = mdxToMarkdown(
    '<ProductLink path="/sign-in?from=blog" paragraph>Start free.</ProductLink>',
  )

  expect(output).toBe(`[Start free.](${resolveConfiguredProductOrigin()}/sign-in?from=blog)`)
})

test('unwraps a container written inline', () => {
  expect(mdxToMarkdown('<Callout emoji="❓">**Questions this page answers**</Callout>')).toBe(
    '**Questions this page answers**',
  )
})

test('leaves no JSX tag behind in a real guide body', async () => {
  const { getAllGuides, getAllPosts } = await import('@/lib/blog/content')
  const offenders: string[] = []
  const posts = getAllPosts('en')
  const guides = getAllGuides('en')
  expect(posts.length).toBeGreaterThan(0)
  expect(guides.length).toBeGreaterThan(0)

  for (const post of [...posts, ...guides]) {
    const match = /<\/?[A-Z][A-Za-z]*/.exec(mdxToMarkdown(post.content))
    if (match) offenders.push(`${post.slug}: ${match[0]}`)
  }

  expect(offenders).toEqual([])
})
