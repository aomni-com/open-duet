import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import PlaygroundPage from './page'

test('the playground opens the deterministic onboarding preview instead of a workspace-less route', () => {
  const html = renderToStaticMarkup(<PlaygroundPage />)

  expect(html).toContain('href="/playground/onboarding"')
  expect(html).not.toContain('href="/onboarding"')
})

test('the playground exposes the shared session chat workbench', () => {
  const html = renderToStaticMarkup(<PlaygroundPage />)

  expect(html).toContain('href="/playground/session-chat"')
  expect(html).toContain('Chat primitive — jobs and default AI chat')
})
