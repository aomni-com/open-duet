import { describe, expect, test } from 'bun:test'

import { buildWorkspaceTabs, workspaceTabForPath } from './workspace-tabs'

describe('Workspace tabs', () => {
  test('carries the workspace destinations in reading order, desktop hidden', () => {
    expect(buildWorkspaceTabs(destination => destination).map(tab => tab.value)).toEqual([
      'agents',
      'files',
      'integrations',
    ])
  })

  /* There is no workspace-level session or app address left to light anything:
     both belong to an agent and are read on that agent's surface. Desktop still
     has a route, but no button — lighting it would point the panel's
     aria-labelledby at a tab id the bar no longer renders. */
  test('lights nothing on an address without a button', () => {
    expect(workspaceTabForPath('/w/acme/sessions')).toBeNull()
    expect(workspaceTabForPath('/w/acme/sessions/session_1')).toBeNull()
    expect(workspaceTabForPath('/w/acme/apps/reporting')).toBeNull()
    expect(workspaceTabForPath('/w/acme/desktop')).toBeNull()
  })

  test('lights the destination a carried path belongs to', () => {
    expect(workspaceTabForPath('/w/acme/agents')).toBe('agents')
    expect(workspaceTabForPath('/w/acme/agents/research/sessions/session_1')).toBe('agents')
    expect(workspaceTabForPath('/w/acme/files/reports')).toBe('files')
    expect(workspaceTabForPath('/w/acme/integrations')).toBe('integrations')
    expect(workspaceTabForPath('/w/acme/settings/general')).toBeNull()
  })
})
