import { expect, test } from 'bun:test'

import { NextRequest } from 'next/server'

import proxy from './proxy'

const visit = (pathname: string) => proxy(new NextRequest(new URL(pathname, 'https://duet.so')))

test('serves a markdown twin from the /md segment without changing the visible URL', () => {
  const response = visit('/blog/claude-code-vs-cursor-vs-codex.md')

  expect(response.headers.get('x-middleware-rewrite')).toBe(
    'https://duet.so/md/blog/claude-code-vs-cursor-vs-codex',
  )
  expect(response.status).toBe(200)
})

test('leaves the human page alone', () => {
  const response = visit('/blog/claude-code-vs-cursor-vs-codex')

  expect(response.headers.get('x-middleware-rewrite')).not.toContain('/md/')
})

test('keeps redirecting a consolidated Spanish page even though rewriting comes first', () => {
  const response = visit('/es/blog/claude-code-vs-cursor-vs-codex')

  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe(
    'https://duet.so/blog/claude-code-vs-cursor-vs-codex',
  )
})

test('permanently consolidates the legacy production host onto the canonical domain', () => {
  const response = proxy(new NextRequest('https://lander.duet.so/guides?utm_source=legacy'))

  expect(response.status).toBe(308)
  expect(response.headers.get('location')).toBe('https://duet.so/guides?utm_source=legacy')
})
