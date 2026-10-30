import { expect, it } from 'bun:test'

import { executeRemoteCommand } from '../src/remote-controller'

it('allows only the fixed probe command surface', async () => {
  const calls: unknown[] = []
  const probe = {
    startInputFixture: () => {
      calls.push('start')
      return { startedAtMs: 100, endsAtMs: 550 }
    },
  }

  expect(
    await executeRemoteCommand(probe, {
      id: 1,
      method: 'startInputFixture',
      argument: null,
    }),
  ).toEqual({ startedAtMs: 100, endsAtMs: 550 })
  expect(calls).toEqual(['start'])
  await expect(
    executeRemoteCommand(probe, { id: 2, method: 'evaluate', argument: 'secret' }),
  ).rejects.toThrow('unsupported mobile probe command')
})

it('serializes successful void commands as explicit null results', async () => {
  expect(
    await executeRemoteCommand(
      {
        connect: async () => undefined,
        disconnect: async () => undefined,
      },
      { id: 1, method: 'connect', argument: {} },
    ),
  ).toBeNull()
  expect(
    await executeRemoteCommand(
      {
        connect: async () => undefined,
        disconnect: async () => undefined,
      },
      { id: 2, method: 'disconnect', argument: null },
    ),
  ).toBeNull()
})
