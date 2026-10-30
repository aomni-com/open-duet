import { expect, test } from 'bun:test'

import { driveFileIconPath } from './drive-file-icon'

test('joins an icon filename beneath its anchor folder', () => {
  expect(driveFileIconPath({ anchorPath: 'agents/research', icon: 'assets/icon.png' })).toBe(
    'agents/research/assets/icon.png',
  )
  expect(driveFileIconPath({ anchorPath: 'agents/research' })).toBeUndefined()
})
