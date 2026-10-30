import { describe, expect, test } from 'bun:test'

import {
  MAX_PUBLISH_SNAPSHOT_COMPONENT_UTF8_BYTES,
  PublishResponseSchema,
  PublishSnapshotComponentSchema,
  isPublishExcludedDrivePath,
} from './index'

test('publish snapshot generations are bounded at storage and public response seams', () => {
  const maximum = 'a'.repeat(MAX_PUBLISH_SNAPSHOT_COMPONENT_UTF8_BYTES)
  expect(PublishSnapshotComponentSchema.parse(maximum)).toBe(maximum)
  expect(PublishSnapshotComponentSchema.safeParse(`${maximum}a`).success).toBe(false)
  expect(
    PublishResponseSchema.safeParse({
      publish: {
        id: 'publish',
        workspaceId: 'workspace',
        anchorId: 'anchor',
        anchorPath: 'docs',
        slug: 'docs',
        kind: 'folder',
        pauseGeneration: `${maximum}a`,
        createdByUserId: 'user',
        createdAt: 1,
        updatedAt: 1,
      },
    }).success,
  ).toBe(false)
})

// The publish serving floor: what a publish NEVER serves, at any depth,
// whatever the UI shows. Everything else — ordinary dotfiles included — is
// public once a folder is published.
describe('isPublishExcludedDrivePath', () => {
  test('env-like segments are excluded at any depth', () => {
    expect(isPublishExcludedDrivePath('.env')).toBe(true)
    expect(isPublishExcludedDrivePath('config/.env.local')).toBe(true)
    expect(isPublishExcludedDrivePath('.envrc')).toBe(true)
  })

  test('the share floor is excluded: .git, node_modules, .duet-anchor', () => {
    expect(isPublishExcludedDrivePath('.git')).toBe(true)
    expect(isPublishExcludedDrivePath('.git/config')).toBe(true)
    expect(isPublishExcludedDrivePath('app/node_modules/pkg/index.js')).toBe(true)
    expect(isPublishExcludedDrivePath('.duet-anchor')).toBe(true)
    expect(isPublishExcludedDrivePath('nested/.duet-anchor')).toBe(true)
  })

  test('ordinary dotfiles and dotdirs are NOT excluded', () => {
    expect(isPublishExcludedDrivePath('.agents/skills/deploy/SKILL.md')).toBe(false)
    expect(isPublishExcludedDrivePath('.notes')).toBe(false)
    expect(isPublishExcludedDrivePath('.gitignore')).toBe(false)
    expect(isPublishExcludedDrivePath('docs/readme.md')).toBe(false)
    expect(isPublishExcludedDrivePath('')).toBe(false)
  })

  test('lookalike names are not the floor: .github, node_modules_backup', () => {
    expect(isPublishExcludedDrivePath('.github/workflows/ci.yml')).toBe(false)
    expect(isPublishExcludedDrivePath('node_modules_backup/keep.js')).toBe(false)
  })
})
