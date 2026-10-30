import { expect, test } from 'bun:test'

import { resolveDeployedVersion, resolveReleaseRevision } from './deployed-version'

test('release revision accepts only the platform full commit', () => {
  expect(
    resolveReleaseRevision({
      VERCEL_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    }),
  ).toBe('0123456789abcdef0123456789abcdef01234567')
  expect(resolveReleaseRevision({ VERCEL_GIT_COMMIT_SHA: 'short' })).toBeNull()
  expect(resolveReleaseRevision({})).toBeNull()
})

test('the deployment id identifies a Vercel deployment ahead of its commit', () => {
  const version = resolveDeployedVersion({
    env: { VERCEL_DEPLOYMENT_ID: 'dpl_abc', VERCEL_GIT_COMMIT_SHA: 'sha_def' },
    readBuildId: () => 'build_ghi',
  })

  expect(version).toBe('dpl_abc')
})

test('a commit sha identifies the deployment when the platform omits a deployment id', () => {
  const version = resolveDeployedVersion({
    env: { VERCEL_GIT_COMMIT_SHA: 'sha_def' },
    readBuildId: () => 'build_ghi',
  })

  expect(version).toBe('sha_def')
})

test('a self-hosted build falls back to the build id Next stamps into the output', () => {
  const version = resolveDeployedVersion({ env: {}, readBuildId: () => 'build_ghi' })

  expect(version).toBe('build_ghi')
})

test('an absent build ID falls back to a nonempty dev-prefixed version', () => {
  const version = resolveDeployedVersion({
    env: {},
    readBuildId: () => {
      throw new Error('ENOENT')
    },
  })

  expect(version.startsWith('dev-')).toBe(true)
  expect(version.length).toBeGreaterThan('dev-'.length)
})

test('blank platform variables do not masquerade as a deployment identity', () => {
  const version = resolveDeployedVersion({
    env: { VERCEL_DEPLOYMENT_ID: '', VERCEL_GIT_COMMIT_SHA: '  ' },
    readBuildId: () => 'build_ghi',
  })

  expect(version).toBe('build_ghi')
})
