import { expect, test } from 'bun:test'

import { appFrameSource } from './app-frame'

/* The frame source only. An app's *address* used to live here too and it named
   a workspace-level `/w/:ws/apps/:slug` page; an app belongs to whichever
   agent's folder encloses it, so it is addressed under that agent by
   `agents-map-url` and there is no page-level route left to build. */
test('frames every app through the grant-minting launch path', () => {
  expect(appFrameSource('acme', 'reporting')).toBe('/api/duet/ws/acme/apps/reporting/launch')
  // Slugs reach the frame source as URL segments, never raw.
  expect(appFrameSource('a c/me', 'rep orting')).toBe(
    '/api/duet/ws/a%20c%2Fme/apps/rep%20orting/launch',
  )
})
