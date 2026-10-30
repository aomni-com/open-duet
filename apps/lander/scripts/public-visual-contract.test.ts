import { expect, test } from 'bun:test'

import {
  NO_JS_PUBLIC_ROUTES,
  publicRouteId,
  VISUAL_PUBLIC_ROUTES,
} from '../tests/visual/public-visual-contract'

test('public screenshot ids stay stable when URL paths encode tag spaces', () => {
  expect(publicRouteId('/blog/tag/AI%20agents')).toBe('blog--tag--AI-agents-a4b6616d57')
})

test('generated editorial pages use a bounded representative visual set', () => {
  const blogPosts = VISUAL_PUBLIC_ROUTES.map(route => route.publicPath).filter(pathname =>
    /^\/(?:es\/)?blog\/[^/]+$/.test(pathname),
  )
  expect(blogPosts).toEqual([
    '/blog/6-best-ai-agent-builders-in-2026',
    '/blog/mcp-servers-for-claude-code-examples',
    '/es/blog/6-best-ai-agent-builders-in-2026',
  ])
})

test('pricing has full-page desktop and mobile coverage in both locales', () => {
  expect(NO_JS_PUBLIC_ROUTES).toContain('/pricing')
  expect(NO_JS_PUBLIC_ROUTES).toContain('/es/pricing')
})
