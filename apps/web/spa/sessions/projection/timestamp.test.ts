import { expect, test } from 'bun:test'

import { TRANSCRIPT_EVENTS, TRANSCRIPT_SNAPSHOT } from './fixtures'
import { projectSession } from './index'

test('dates an assistant message from the start of its turn', () => {
  const projected = projectSession({
    snapshot: TRANSCRIPT_SNAPSHOT,
    durableEvents: TRANSCRIPT_EVENTS,
  })

  expect(projected.messages[1]).toMatchObject({
    role: 'agent',
    createdAt: TRANSCRIPT_EVENTS[2]!.createdAt,
  })
})
