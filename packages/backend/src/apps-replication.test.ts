import { describe, expect, test } from 'bun:test'

import {
  activeAppsWithinShareRoot,
  isAppPathWithinShareRoot,
  translateAppPathToShareMount,
} from '../convex/domains/apps/replication'

describe('app share replication paths', () => {
  test('membership includes the root and nested paths but not sibling prefixes', () => {
    expect(isAppPathWithinShareRoot('project', 'project')).toBe(true)
    expect(isAppPathWithinShareRoot('project/apps/nested/web', 'project')).toBe(true)
    expect(isAppPathWithinShareRoot('projector/apps/web', 'project')).toBe(false)
  })

  test('translation re-roots root and nested app paths onto the recipient mount', () => {
    expect(translateAppPathToShareMount('project', 'project', 'from-a/project')).toBe(
      'from-a/project',
    )
    expect(translateAppPathToShareMount('project/apps/web', 'project', 'from-a/project')).toBe(
      'from-a/project/apps/web',
    )
  })

  test('filters one loaded workspace app set for multiple share roots', () => {
    const loaded = [
      {
        app: { slug: 'dashboard' },
        anchor: { path: 'project/dashboard', state: 'active' },
      },
      {
        app: { slug: 'notes' },
        anchor: { path: 'notes', state: 'active' },
      },
    ]

    expect(activeAppsWithinShareRoot(loaded, 'project').map(({ app }) => app.slug)).toEqual([
      'dashboard',
    ])
    expect(activeAppsWithinShareRoot(loaded, 'notes').map(({ app }) => app.slug)).toEqual(['notes'])
  })
})
