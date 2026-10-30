import { describe, expect, test } from 'bun:test'

import { headingAnchor, routeFromMdxPath } from './verify-content-core'

describe('docs content address helpers', () => {
  test('maps file-routed MDX to public paths', () => {
    expect(routeFromMdxPath('app/page.mdx')).toBe('/')
    expect(routeFromMdxPath('app/getting-started/page.mdx')).toBe('/getting-started')
  })

  test('matches the heading anchors emitted for plain developer headings', () => {
    expect(headingAnchor('SSE and resume')).toBe('sse-and-resume')
    expect(headingAnchor('Errors: retry & recover')).toBe('errors-retry-recover')
  })
})
