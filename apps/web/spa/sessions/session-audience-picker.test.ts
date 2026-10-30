import { expect, test } from 'bun:test'

import {
  audienceCollectionState,
  audiencePreviewMembers,
  audienceRequest,
  audienceRequestKey,
  effectiveAudienceIds,
} from './session-audience-picker'

test('specific audience request sends only sorted additional public user ids', () => {
  expect(effectiveAudienceIds('user_ada', ['user_linus', 'user_ada', 'user_grace'])).toEqual([
    'user_ada',
    'user_grace',
    'user_linus',
  ])
  expect(audienceRequest('workspace', 'user_ada', ['user_grace'])).toBeUndefined()
  expect(audienceRequest('specific', 'user_ada', ['user_grace', 'user_ada'])).toEqual({
    kind: 'specific',
    memberUserIds: ['user_grace'],
  })
  expect(audienceRequest('personal', 'user_ada', ['user_grace', 'user_ada'])).toEqual({
    kind: 'specific',
    memberUserIds: [],
  })
  expect(audienceRequestKey('personal', 'user_ada', ['user_grace'])).toBe(
    audienceRequestKey('specific', 'user_ada', []),
  )
})

test('an empty member page is terminal only after pagination settles', () => {
  expect(audienceCollectionState(0, false, false)).toBe('empty')
  expect(audienceCollectionState(0, true, false)).toBe('incomplete')
  expect(audienceCollectionState(0, false, true)).toBe('incomplete')
  expect(audienceCollectionState(1, true, false)).toBe('rows')
})

test('a crowded audience keeps a bounded people-only preview', () => {
  const creator = { id: 'user_ada', name: 'Ada Lovelace', email: 'ada@example.com' }
  const selected = Array.from({ length: 9 }, (_, index) => ({
    id: `user_${index}`,
    name: `Person ${index}`,
    email: `person-${index}@example.com`,
  }))

  expect(audiencePreviewMembers(creator, [creator, ...selected])).toEqual({
    members: [creator, ...selected.slice(0, 3)],
    count: 10,
    overflow: 6,
  })
})
