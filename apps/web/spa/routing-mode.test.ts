import { describe, expect, test } from 'bun:test'

import { routingModeForInitialPath } from './routing-mode'

describe('SPA routing mode', () => {
  test('uses browser history in production while fixtures can opt into memory history', () => {
    expect(routingModeForInitialPath(undefined)).toEqual({ kind: 'browser' })
    expect(routingModeForInitialPath('/w/acme/sessions')).toEqual({
      kind: 'memory',
      initialPath: '/w/acme/sessions',
    })
  })
})
