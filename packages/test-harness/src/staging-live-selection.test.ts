import { describe, expect, test } from 'bun:test'

import { parseStagingLiveSelection, STAGING_JOURNEYS } from './staging-live-selection'

describe('staging live journey selection', () => {
  test('selects app credential export on the existing ephemeral workspace fixture', () => {
    expect(parseStagingLiveSelection(['--journey', 'app-key-export'])).toEqual({
      kind: 'journey',
      name: 'app-key-export',
    })
    expect(
      Object.entries(STAGING_JOURNEYS).find(([name]) => name === 'app-key-export')?.[1].fixture,
    ).toBe('workspace-browser')
  })
  test('selects the model refresh journey without running the full suite', () => {
    expect(parseStagingLiveSelection(['--journey', 'model-refresh'])).toEqual({
      kind: 'journey',
      name: 'model-refresh',
    })
    expect(
      Object.entries(STAGING_JOURNEYS).find(([name]) => name === 'model-refresh')?.[1].fixture,
    ).toBe('workspace-browser')
  })
  test('selects provider aliases through the ephemeral workspace-browser fixture', () => {
    expect(parseStagingLiveSelection(['--journey', 'provider-model-aliases'])).toEqual({
      kind: 'journey',
      name: 'provider-model-aliases',
    })
    expect(STAGING_JOURNEYS['provider-model-aliases'].fixture).toBe('workspace-browser')
  })
  test('defaults to the complete suite', () => {
    expect(parseStagingLiveSelection([])).toEqual({ kind: 'all' })
  })

  test('selects a registered focused journey', () => {
    expect(parseStagingLiveSelection(['--journey', 'agentic-onboarding'])).toEqual({
      kind: 'journey',
      name: 'agentic-onboarding',
    })
  })

  test('selects the workspace invitation journey independently', () => {
    expect(parseStagingLiveSelection(['--journey', 'workspace-invitations'])).toEqual({
      kind: 'journey',
      name: 'workspace-invitations',
    })
  })

  test('registers the specific-people sessions journey on the workspace-browser fixture', () => {
    expect(parseStagingLiveSelection(['--journey', 'specific-people-sessions'])).toEqual({
      kind: 'journey',
      name: 'specific-people-sessions',
    })
    expect(STAGING_JOURNEYS['specific-people-sessions'].fixture).toBe('workspace-browser')
  })

  test('selects the session lineage API journey', () => {
    expect(parseStagingLiveSelection(['--journey', 'session-lineage-api'])).toEqual({
      kind: 'journey',
      name: 'session-lineage-api',
    })
    expect(STAGING_JOURNEYS['session-lineage-api'].fixture).toBe('workspace-browser')
  })

  test('rejects unknown or ambiguous arguments', () => {
    expect(() => parseStagingLiveSelection(['--journey', 'unknown'])).toThrow(
      'Unknown staging journey',
    )
    expect(() =>
      parseStagingLiveSelection(['--journey', 'drive-deep-links', '--journey', 'other']),
    ).toThrow('Usage:')
  })
})

for (const name of ['agent-correction-completion', 'agent-populated-search'] as const) {
  test(`selects ${name} cold from the workspace-browser fixture`, () => {
    expect(parseStagingLiveSelection(['--journey', name])).toEqual({ kind: 'journey', name })
    expect(Object.entries(STAGING_JOURNEYS).find(([key]) => key === name)?.[1].fixture).toBe(
      'workspace-browser',
    )
  })
}

test('app domains selects one ephemeral workspace-browser journey instead of the full run', () => {
  expect(parseStagingLiveSelection(['--journey', 'app-domains'])).toEqual({
    kind: 'journey',
    name: 'app-domains',
  })
  expect(
    Object.entries(STAGING_JOURNEYS).find(([name]) => name === 'app-domains')?.[1].fixture,
  ).toBe('workspace-browser')
})

test('unified duet selects one disposable workspace-browser closeout journey', () => {
  expect(parseStagingLiveSelection(['--journey', 'unified-duet'])).toEqual({
    kind: 'journey',
    name: 'unified-duet',
  })
  expect(
    Object.entries(STAGING_JOURNEYS).find(([name]) => name === 'unified-duet')?.[1].fixture,
  ).toBe('workspace-browser')
})

test('open model access runs independently on one disposable workspace', () => {
  expect(parseStagingLiveSelection(['--journey', 'open-model-access'])).toEqual({
    kind: 'journey',
    name: 'open-model-access',
  })
  expect(
    Object.entries(STAGING_JOURNEYS).find(([name]) => name === 'open-model-access')?.[1].fixture,
  ).toBe('workspace-browser')
})

test('service catalog closeout is selectable as a paid backend journey', () => {
  expect(parseStagingLiveSelection(['--journey', 'service-catalog'])).toEqual({
    kind: 'journey',
    name: 'service-catalog',
  })
  expect(STAGING_JOURNEYS['service-catalog'].fixture).toBe('backend')
})
