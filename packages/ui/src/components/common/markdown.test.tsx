import { expect, test } from 'bun:test'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Markdown } from './markdown'

const fixture = `First line
second line with [docs](/guide) and **bold**.

- one
- two

![diagram](media/plot.png)

<span>hidden</span>`

test('renders links, emphasis, lists, and images, and strips raw HTML to text', () => {
  const html = renderToStaticMarkup(<Markdown>{fixture}</Markdown>)

  // Links leave the app in a new tab and keep the authored href.
  expect(html).toContain('<a target="_blank" href="/guide">docs</a>')
  expect(html).toContain('<strong>bold</strong>')

  // Block markdown is really parsed, not passed through as literal text.
  expect(html).toContain('<li>one</li>')
  expect(html).toContain('<li>two</li>')

  // Markdown reaches this component from agent output and shared documents,
  // so a raw tag must never become live markup...
  expect(html).not.toContain('<span>')
  // ...and `skipHtml` drops the tag rather than react-markdown's default of
  // showing the user its escaped source text.
  expect(html).not.toContain('&lt;span&gt;')
  expect(html).toContain('hidden')

  expect(html).toContain('<img src="media/plot.png" alt="diagram"/>')

  // Our paragraph override, not react-markdown's: without whitespace-pre-wrap
  // the authored newline inside a paragraph collapses and multi-line agent
  // messages run together.
  expect(html).toContain('whitespace-pre-wrap')
  expect(html).toContain('First line\nsecond line')
})

test('a hard break does not add a second preserved newline', () => {
  const html = renderToStaticMarkup(<Markdown>{'before  \nafter'}</Markdown>)

  expect(html).toContain('before<br/>after')
  expect(html).not.toContain('before<br/>\nafter')
})

test('passes image source and alt text to a caller component', () => {
  const received: Array<{ src?: string; alt?: string }> = []

  function ImageStub({ src, alt }: { src?: string; alt?: string }) {
    received.push({ src, alt })
    return <span data-image-stub={`${src}:${alt}`} />
  }

  const html = renderToStaticMarkup(
    <Markdown components={{ img: ImageStub }}>![diagram](media/plot.png)</Markdown>,
  )

  expect(received).toEqual([{ src: 'media/plot.png', alt: 'diagram' }])
  expect(html).toContain('data-image-stub="media/plot.png:diagram"')
})

test('lets a caller override the default anchor component', () => {
  function AnchorStub({ href, children }: { href?: string; children?: ReactNode }) {
    return <span data-anchor-stub={href}>{children}</span>
  }

  const html = renderToStaticMarkup(
    <Markdown components={{ a: AnchorStub }}>[docs](/guide)</Markdown>,
  )

  expect(html).toContain('<span data-anchor-stub="/guide">docs</span>')
  expect(html).not.toContain('target="_blank"')
})
