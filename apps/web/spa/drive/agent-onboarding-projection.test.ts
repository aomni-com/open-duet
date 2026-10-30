import { expect, test } from 'bun:test'

import { agentIsLocked, resolveAgentConfig, type App } from '@repo/contract'

import {
  isAgentOnboardingAppPending,
  agentTrainSurface,
  onboardingAppCwd,
  resolveOnboardingApp,
  visibleAgentApps,
} from './agent-onboarding-projection'

function app(id: string, anchorPath: string, slug = id): App {
  return { id, anchorPath, slug } as App
}

const regularApp = app('regular', 'agents/research/tools/briefs')
const onboardingApp = app('onboarding', 'agents/research/.onboarding/style-picker', 'style-picker')

test('an app onboarding stays pending only until its declared app appears', () => {
  const config = resolveAgentConfig(
    JSON.stringify({ onboarding: { kind: 'app', app: '.onboarding/style-picker' } }),
  )

  expect(isAgentOnboardingAppPending(true, config, 'agents/research', [])).toBe(true)
  expect(isAgentOnboardingAppPending(true, config, 'agents/research', [onboardingApp])).toBe(false)
  expect(isAgentOnboardingAppPending(false, config, 'agents/research', [])).toBe(false)
})

test('an onboarding app has one exact cwd lookup independent of catalog position', () => {
  const config = resolveAgentConfig(
    JSON.stringify({ onboarding: { kind: 'app', app: '.onboarding/style-picker' } }),
  )

  expect(onboardingAppCwd(config, 'agents/research')).toBe(
    'agents/research/.onboarding/style-picker',
  )
  expect(
    resolveOnboardingApp(config, 'agents/research', [app('ancestor', 'agents/research')]),
  ).toBe(undefined)
})

test.each([
  [
    'unreadable config',
    undefined,
    undefined,
    'agents/research',
    [onboardingApp, regularApp],
    false,
    'enabled',
    ['onboarding', 'regular'],
    undefined,
  ],
  [
    'malformed config',
    '{"onboarding":',
    undefined,
    'agents/research',
    [onboardingApp, regularApp],
    false,
    'enabled',
    ['onboarding', 'regular'],
    undefined,
  ],
  [
    'unknown config fields',
    JSON.stringify({ futureField: { enabled: true } }),
    undefined,
    'agents/research',
    [onboardingApp, regularApp],
    false,
    'enabled',
    ['onboarding', 'regular'],
    undefined,
  ],
  [
    'declared onboarding with onboardedAt set',
    JSON.stringify({ onboarding: { kind: 'chat' } }),
    1,
    'agents/research',
    [regularApp],
    false,
    'enabled',
    ['regular'],
    undefined,
  ],
  [
    'declared onboarding with onboardedAt unset',
    JSON.stringify({ onboarding: { kind: 'chat' } }),
    undefined,
    'agents/research',
    [regularApp],
    true,
    'enabled',
    ['regular'],
    undefined,
  ],
  [
    'hideAfterOnboarded omitted',
    JSON.stringify({
      onboarding: { kind: 'app', app: '.onboarding/style-picker' },
    }),
    1,
    'agents/research',
    [onboardingApp, regularApp],
    false,
    'enabled',
    ['regular'],
    'onboarding',
  ],
  [
    'hideAfterOnboarded false',
    JSON.stringify({
      onboarding: {
        kind: 'app',
        app: '.onboarding/style-picker',
        hideAfterOnboarded: false,
      },
    }),
    1,
    'agents/research',
    [onboardingApp, regularApp],
    false,
    'enabled',
    ['onboarding', 'regular'],
    'onboarding',
  ],
  [
    'trainable false',
    JSON.stringify({ trainable: false }),
    undefined,
    'agents/research',
    [regularApp],
    false,
    'disabled',
    ['regular'],
    undefined,
  ],
  [
    'onboarding app resolving to nothing',
    JSON.stringify({
      onboarding: { kind: 'app', app: '.onboarding/missing' },
    }),
    undefined,
    'agents/research',
    [regularApp],
    true,
    'enabled',
    ['regular'],
    undefined,
  ],
  [
    'replica with a suffixed slug and preserved path',
    JSON.stringify({
      onboarding: { kind: 'app', app: '.onboarding/style-picker' },
    }),
    undefined,
    'agents/shared/',
    [
      app('wrong', 'apps/unrelated', 'style-picker'),
      app('replica', 'agents/shared/.onboarding/style-picker', 'style-picker-2'),
    ],
    true,
    'enabled',
    ['wrong', 'replica'],
    'replica',
  ],
] as const)(
  'config projection truth table: %s',
  (
    _name,
    source,
    onboardedAt,
    anchorPath,
    apps,
    locked,
    trainSurface,
    visibleAppIds,
    onboardingAppId,
  ) => {
    const config = resolveAgentConfig(source)
    const agent = onboardedAt === undefined ? {} : { onboardedAt }

    expect(agentIsLocked(agent, config)).toBe(locked)
    expect(agentTrainSurface(config)).toBe(trainSurface)
    expect(visibleAgentApps(agent, config, anchorPath, [...apps]).map(item => item.id)).toEqual([
      ...visibleAppIds,
    ])
    expect(resolveOnboardingApp(config, anchorPath, [...apps])?.id).toBe(onboardingAppId)
  },
)
