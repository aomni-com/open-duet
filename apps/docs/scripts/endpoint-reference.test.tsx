import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { EndpointReference } from '../components/endpoint-reference'

test('renders collection and endpoint-specific errors from the composed contract schema', () => {
  const markup = renderToStaticMarkup(<EndpointReference category="sessions" />)
  const audience = markup.slice(
    markup.indexOf('id="sessions.audience"'),
    markup.indexOf('id="sessions.audience.update"'),
  )

  expect(audience).toContain('Opaque collection cursor is malformed')
  expect(audience).toContain('invalid_cursor')
  expect(audience.match(/invalid_cursor/g)).toHaveLength(1)
  expect(audience).toContain('The session is unavailable to this caller')
  expect(audience).toContain('audience_kind_immutable')
  expect(audience).not.toContain('invalid_audience_member')
})
