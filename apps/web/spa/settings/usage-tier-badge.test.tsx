import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { MODEL_SELECTIONS } from '@repo/contract'

import { UsageTierBadge } from './usage-tier-badge'

test('renders only the public tier label for a usage row', () => {
  const markup = renderToStaticMarkup(<UsageTierBadge tier="frontier" />)

  expect(markup).toContain(MODEL_SELECTIONS.frontier.label)
  expect(markup).not.toContain('anthropic')
  expect(markup).not.toContain('upstream')
  expect(markup).not.toContain('$')
})
