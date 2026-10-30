import { describe, expect, test } from 'bun:test'

import {
  backendReleaseRevisionSource,
  deploymentRailPlan,
  railMode,
  releaseRevisionForRail,
} from './vercel-deploy-rail.mjs'

describe('Vercel deployment rail', () => {
  const convexDeployStep = {
    cwd: 'packages/backend',
    command: 'bun',
    args: [
      'run',
      'deploy:ci',
      '--',
      '--cmd',
      'bun run --cwd ../seed-drive publish && bun run --cwd ../../apps/api build:vercel',
    ],
  }

  test('production deploys Convex, publishes the seed, then promotes the API build', () => {
    expect(deploymentRailPlan('production')).toEqual({
      environment: 'production',
      requiredEnvironmentVariables: ['CONVEX_DEPLOY_KEY'],
      steps: [convexDeployStep],
    })
  })

  test('non-production Vercel environments use the shared staging configuration', () => {
    for (const vercelEnvironment of ['preview', 'development', undefined]) {
      expect(deploymentRailPlan(vercelEnvironment)).toEqual({
        environment: 'staging',
        requiredEnvironmentVariables: ['CONVEX_DEPLOY_KEY'],
        steps: [convexDeployStep],
      })
    }
  })
})

test('railMode: all credentials present runs the rail', () => {
  const plan = deploymentRailPlan('preview')
  const env = {
    ...Object.fromEntries(plan.requiredEnvironmentVariables.map(name => [name, 'x'])),
    VERCEL_GIT_COMMIT_REF: 'staging',
  }
  expect(railMode(plan, env).mode).toBe('run')
})

test('feature and dependency previews build without replacing the shared backend', () => {
  const plan = deploymentRailPlan('preview')
  for (const ref of [
    'codex/harness-update',
    'dependabot/npm_and_yarn/packages/agent/nanoid',
    undefined,
  ]) {
    expect(
      railMode(plan, { CONVEX_DEPLOY_KEY: 'staging-key', VERCEL_GIT_COMMIT_REF: ref }).mode,
    ).toBe('skip-preview')
  }
  expect(
    railMode(plan, { CONVEX_DEPLOY_KEY: 'staging-key', VERCEL_GIT_COMMIT_REF: 'staging' }).mode,
  ).toBe('run')
  expect(
    railMode(deploymentRailPlan('production'), {
      CONVEX_DEPLOY_KEY: 'production-key',
      VERCEL_GIT_COMMIT_REF: 'codex/additive-cutover',
    }).mode,
  ).toBe('run')
})

test('railMode: fully absent credentials skip as unbootstrapped', () => {
  const plan = deploymentRailPlan('preview')
  expect(railMode(plan, { VERCEL_GIT_COMMIT_REF: 'staging' }).mode).toBe('skip-unbootstrapped')
})

test('railMode: partially-present credentials are a hard failure (broken bootstrap)', () => {
  // The real plan needs a single credential, so it is only ever run-or-skip;
  // the fail branch guards a plan that grows to several required vars, where a
  // half-configured set must break loudly rather than silently skip.
  const plan = { requiredEnvironmentVariables: ['A', 'B'] }
  const result = railMode(plan, { A: 'x' })
  expect(result.mode).toBe('fail')
  expect(result.missing).toEqual(['B'])
})

test('releaseRevisionForRail: requires the full immutable Vercel revision', () => {
  const revision = '0123456789abcdef0123456789abcdef01234567'
  expect(releaseRevisionForRail({ VERCEL_GIT_COMMIT_SHA: revision })).toBe(revision)

  for (const value of [undefined, '', '0123456', revision.toUpperCase()]) {
    expect(() => releaseRevisionForRail({ VERCEL_GIT_COMMIT_SHA: value })).toThrow()
  }
})

test('backendReleaseRevisionSource: bakes the validated revision into loadable deployed source', async () => {
  const revision = '0123456789abcdef0123456789abcdef01234567'
  const emitted = backendReleaseRevisionSource(revision)
  const module = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`)
  expect(module.DEPLOYED_RELEASE_REVISION).toBe(revision)
  expect(() => backendReleaseRevisionSource('short')).toThrow('full lowercase revision')
})
