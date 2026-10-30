import { expect, test } from 'bun:test'

import { gatewayEntryMode } from './index'

test('the release bundle exposes the desktop-browser shim without a second release artifact', () => {
  expect(gatewayEntryMode(['bun', '/opt/duet/current/index.js'])).toBe('gateway')
  expect(gatewayEntryMode(['bun', '/opt/duet/current/index.js', '--desktop-browser-cli'])).toBe(
    'desktop-browser',
  )
})
