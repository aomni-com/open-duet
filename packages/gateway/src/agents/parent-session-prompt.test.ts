import { expect, test } from 'bun:test'

import { parentSessionPrompt } from './parent-session-prompt'

test('a known workspace slug lands in the route, and an unknown one is resolved first', () => {
  const known = parentSessionPrompt({ parentSessionId: 'session-parent', workspaceSlug: 'acme' })
  expect(known).toContain('/v1/ws/acme/agent/sessions/session-parent/messages/wait')
  expect(known).not.toContain('/v1/whoami')

  const unknown = parentSessionPrompt({ parentSessionId: 'session-parent', workspaceSlug: undefined })
  expect(unknown).toContain('/v1/whoami')
  expect(unknown).toContain('/v1/ws/$WORKSPACE_SLUG/agent/sessions/session-parent/messages/wait')
})
