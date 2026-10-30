import { expect, test } from 'bun:test'

import { appProductUrl } from './app-location'

test('an app link resolves its nearest owning agent and falls back to the workspace agent', () => {
  const agents = [
    {
      id: 'agent_research',
      slug: 'research',
      anchorId: 'anchor_research',
      anchorPath: 'agents/research',
    },
    {
      id: 'agent_nested',
      slug: 'nested',
      anchorId: 'anchor_nested',
      anchorPath: 'agents/research/nested',
    },
  ]
  expect(
    appProductUrl(
      'acme',
      { anchorPath: 'agents/research/nested/apps/portal', slug: 'portal' },
      agents,
    ),
  ).toBe('/w/acme/agents/nested/apps/portal')
  expect(appProductUrl('acme', { anchorPath: 'apps/portal', slug: 'portal' }, agents)).toBe(
    '/w/acme/agents/root/apps/portal',
  )
})
