import { describe, expect, test } from 'bun:test'

import { completeProductSignOut, revokeProductBrowserSession } from './sign-out'

describe('product sign-out ownership', () => {
  test('finishes the session revocation body before returning', async () => {
    const order: string[] = []
    const response = new Response('revoked')
    let bodyStarted!: () => void
    let releaseBody!: () => void
    const started = new Promise<void>(resolve => {
      bodyStarted = resolve
    })
    const released = new Promise<void>(resolve => {
      releaseBody = resolve
    })
    response.arrayBuffer = async () => {
      order.push('body-started')
      bodyStarted()
      await released
      order.push('body-finished')
      return new ArrayBuffer(0)
    }
    let settled = false
    const revocation = revokeProductBrowserSession(new AbortController().signal, async () => {
      order.push('fetch')
      return response
    })
    void revocation.then(() => {
      settled = true
    })
    await started
    expect(settled).toBe(false)
    releaseBody()
    await revocation
    expect(settled).toBe(true)
    expect(order).toEqual(['fetch', 'body-started', 'body-finished'])
  })

  test('revokes, resets identity, clears auth, then navigates', async () => {
    const order: string[] = []
    await completeProductSignOut({
      revokeBrowserSession: async () => {
        order.push('revoke')
      },
      resetAnalytics: () => order.push('reset'),
      clearAuth: async () => {
        order.push('clear-auth')
      },
      navigate: () => order.push('navigate'),
    })
    expect(order).toEqual(['revoke', 'reset', 'clear-auth', 'navigate'])
  })

  test('bounds remote revocation but waits for local auth clearing before navigation', async () => {
    const order: string[] = []
    let remoteSignal: AbortSignal | undefined
    let clearStarted!: () => void
    const started = new Promise<void>(resolve => {
      clearStarted = resolve
    })
    let releaseClear!: () => void
    const cleared = new Promise<void>(resolve => {
      releaseClear = resolve
    })
    const signOut = completeProductSignOut({
      revokeBrowserSession: signal => {
        remoteSignal = signal
        return new Promise<void>(resolve =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      },
      resetAnalytics: () => order.push('reset'),
      clearAuth: async () => {
        order.push('clear-auth')
        clearStarted()
        await cleared
      },
      navigate: () => order.push('navigate'),
      timeoutMs: 1,
    })
    await started
    const beforeClear = [...order]
    releaseClear()
    await signOut
    expect(remoteSignal?.aborted).toBe(true)
    expect(beforeClear).toEqual(['reset', 'clear-auth'])
    expect(order).toEqual(['reset', 'clear-auth', 'navigate'])
  })

  test('does not navigate when local auth clearing fails', async () => {
    const order: string[] = []
    await expect(
      completeProductSignOut({
        revokeBrowserSession: async () => undefined,
        resetAnalytics: () => order.push('reset'),
        clearAuth: async () => {
          throw new Error('local storage unavailable')
        },
        navigate: () => order.push('navigate'),
      }),
    ).rejects.toThrow('local storage unavailable')
    expect(order).toEqual(['reset'])
  })
})
