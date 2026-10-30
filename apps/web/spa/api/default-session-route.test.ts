import { expect, test } from 'bun:test'

import { defaultSessionApiPath } from './default-session-route'

/* The wire alias only. There used to be a browser path beside it — a workspace
   level `/w/:ws/sessions/default` — and it went with the destination it named:
   a session belongs to an agent, so the surface that mounts a default chat is
   the agent's own and it already knows whose chat it is asking for. */
test('the default alias resolves root and agent scopes without inventing an id', () => {
  // One family for every owner: root is addressed under its reserved slug, not
  // through a route shape of its own — so there is no null owner to translate.
  expect(defaultSessionApiPath('acme', 'root')).toBe(
    '/api/duet/ws/acme/agents/root/sessions/default',
  )
  expect(defaultSessionApiPath('acme', 'research')).toBe(
    '/api/duet/ws/acme/agents/research/sessions/default',
  )
})
