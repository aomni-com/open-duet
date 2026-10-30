import { expect, test } from 'bun:test'

import { readStoredChain, writeStoredChain } from './onboarding-chain-storage'

test('a stored zero-cursor chain is readable when projected steps are absent', () => {
  // sessionStorage is an environment edge, so stub it rather than the module
  // under test.
  const entries = new Map<string, string>()
  const priorWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
  }

  try {
    const key = 'duet:onboarding-chain:workspace_1'
    writeStoredChain(key, ['research-assistant', 'data-analyst'], 0)

    // This helper round-trip does not mount the orchestrator or prove its
    // initial seeding effect runs before the server projection disappears.
    expect(readStoredChain(key, [])).toEqual({
      steps: ['research-assistant', 'data-analyst'],
      cursor: 0,
    })
  } finally {
    ;(globalThis as { window?: unknown }).window = priorWindow
  }
})
