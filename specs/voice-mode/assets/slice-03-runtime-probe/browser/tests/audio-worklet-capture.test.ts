import { describe, expect, test } from 'bun:test'

import { ensureHeardAudioWorklet } from '../src/audio-worklet-capture'

describe('ensureHeardAudioWorklet', () => {
  test('registers the shared processor once when participant tracks arrive concurrently', async () => {
    let registrations = 0
    let finishRegistration!: () => void
    const registration = new Promise<void>(resolve => {
      finishRegistration = resolve
    })
    const context = {
      audioWorklet: {
        addModule: async () => {
          registrations += 1
          await registration
        },
      },
    } as unknown as AudioContext

    const first = ensureHeardAudioWorklet(context)
    const second = ensureHeardAudioWorklet(context)
    expect(registrations).toBe(1)

    finishRegistration()
    await Promise.all([first, second])
    expect(registrations).toBe(1)
  })
})
