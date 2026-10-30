import { describe, expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { WorkSessionHeading } from './work-session-heading'

describe('WorkSessionHeading', () => {
  test('does not attribute an orchestrated conversation to an agent', () => {
    const html = renderToStaticMarkup(<WorkSessionHeading title="Launch planning" />)

    expect(html.replace(/<[^>]*>/g, '')).toBe('Launch planning')
  })

  test('keeps the parent conversation context for a delegated job', () => {
    const html = renderToStaticMarkup(
      <WorkSessionHeading title="Check the export" source="Job from Launch planning" />,
    )

    expect(html).toContain('Check the export')
    expect(html).toContain('Job from Launch planning')
  })

  /* The rename control takes the heading's place rather than sitting beside it —
     two copies of a conversation's name, one of them editable, is the shape
     where a reader edits the one that is not — but the *heading* survives the
     swap. A reader moving by headings has to reach the conversation's name
     whether or not they are allowed to change it, so the control is wrapped in
     the role instead of replacing it. */
  test('a renameable conversation keeps one name, and it is still the heading', () => {
    const html = renderToStaticMarkup(
      <WorkSessionHeading
        title="Launch planning"
        titleControl={<button type="button">Launch planning</button>}
      />,
    )

    expect(html.split('Launch planning').length - 1).toBe(1)
    const heading = html.match(/<[^>]+role="heading"[^>]*>([\s\S]*?)<\/div>/)?.[1]
    expect(heading).toContain('<button')
    expect(heading?.replace(/<[^>]*>/g, '')).toBe('Launch planning')
    expect(html).toContain('aria-level="1"')
  })
})
