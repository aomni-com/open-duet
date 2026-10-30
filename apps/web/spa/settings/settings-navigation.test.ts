import { expect, test } from 'bun:test'

import { settingsNavigationState, settingsReturnDestination } from './settings-navigation'

test('settings keeps the app destination that opened it', () => {
  const state = settingsNavigationState('/w/acme/agents/research', '?pane=files')
  expect(settingsReturnDestination(state, 'acme')).toBe('/w/acme/agents/research?pane=files')
})

test('settings deep links fall back to workspace home without making a settings loop', () => {
  expect(settingsReturnDestination(undefined, 'acme')).toBe('/w/acme/home')
  expect(settingsReturnDestination({ settingsReturnTo: '/settings/profile' }, 'acme')).toBe(
    '/w/acme/home',
  )
  expect(settingsReturnDestination({ settingsReturnTo: '/w/acme/settings/members' }, 'acme')).toBe(
    '/w/acme/home',
  )
})
