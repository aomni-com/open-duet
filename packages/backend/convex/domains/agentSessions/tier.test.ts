import { describe, expect, test } from 'bun:test'

import { defaultTierFor } from '@repo/contract'

import { resolveSessionTier } from './tier'

describe('resolveSessionTier', () => {
  test('uses a valid requested tier before every stored preference', () => {
    expect(
      resolveSessionTier({
        requested: 'frontier',
        sessionLast: 'balanced',
        workspaceDefault: 'balanced',
        subscriber: true,
      }),
    ).toBe('frontier')
  })

  test('restarts an invalid requested tier at the workspace default', () => {
    expect([
      resolveSessionTier({
        requested: 'recommended',
        sessionLast: 'frontier',
        workspaceDefault: 'balanced',
        subscriber: true,
      }),
      resolveSessionTier({
        requested: 'recommended',
        sessionLast: 'frontier',
        workspaceDefault: 'balanced:zai',
        subscriber: true,
      }),
    ]).toEqual(['balanced', 'balanced'])
  })

  test('skips missing and legacy stored values at each fallback rung', () => {
    expect([
      resolveSessionTier({
        sessionLast: 'frontier',
        workspaceDefault: 'balanced',
        subscriber: true,
      }),
      resolveSessionTier({
        sessionLast: 'fast',
        workspaceDefault: 'frontier',
        subscriber: true,
      }),
      resolveSessionTier({
        sessionLast: 'fast',
        workspaceDefault: 'balanced:zai',
        subscriber: true,
      }),
      resolveSessionTier({ subscriber: false }),
    ]).toEqual([
      'frontier',
      'frontier',
      defaultTierFor({ subscriber: true }),
      defaultTierFor({ subscriber: false }),
    ])
  })

  test('a subscriber with no stored preference defaults to the plan tier', () => {
    // Stored preferences still beat the plan default.
    expect([
      resolveSessionTier({ subscriber: true, plan: 'starter' }),
      resolveSessionTier({ subscriber: true, plan: 'pro' }),
      resolveSessionTier({ subscriber: true, plan: 'max' }),
      resolveSessionTier({ subscriber: true, plan: 'max', workspaceDefault: 'balanced' }),
    ]).toEqual([
      defaultTierFor({ subscriber: true, plan: 'starter' }),
      defaultTierFor({ subscriber: true, plan: 'pro' }),
      defaultTierFor({ subscriber: true, plan: 'max' }),
      'balanced',
    ])
  })

  test('keeps paid preferences for non-subscribers', () => {
    expect([
      resolveSessionTier({ requested: 'frontier', subscriber: false }),
      resolveSessionTier({ sessionLast: 'balanced', subscriber: false }),
    ]).toEqual(['frontier', 'balanced'])
  })
})

test('session aliases survive explicit selection, remembered state and workspace inheritance', () => {
  expect(
    resolveSessionTier({
      requested: 'openai-frontier',
      sessionLast: 'anthropic-max',
      workspaceDefault: 'balanced',
      subscriber: true,
      plan: 'max',
    }),
  ).toBe('openai-frontier')
  expect(
    resolveSessionTier({
      sessionLast: 'anthropic-max',
      workspaceDefault: 'openai-frontier',
      subscriber: false,
    }),
  ).toBe('anthropic-max')
  expect(resolveSessionTier({ workspaceDefault: 'openai-max', subscriber: false })).toBe(
    'openai-max',
  )
})
