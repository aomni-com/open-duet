import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { desktopFocusRequestId, shouldSubmitDesktopFocus } from './workspace-desktop'

describe('workspace desktop viewer admission', () => {
  test('admission observer retries startup auth, retains an expired entry, and remints on reconnect and remount', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./workspace-desktop-lifecycle.fixture.ts', import.meta.url)),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      calls: 4,
      recoveredInitialAdmission: true,
      refusalCalls: 1,
      retainedExpiredEntry: true,
      unauthorizedCalls: 2,
    })
  }, 15_000)
})

describe('agent desktop focus', () => {
  test('constructs the gateway id from page, history entry and agent', () => {
    expect(desktopFocusRequestId('page-1', 'route-1', 'researcher')).toBe(
      'desktop-focus:page-1:route-1:researcher',
    )
  })

  test('submits a defined visit request only when it differs from the previous request', () => {
    expect(shouldSubmitDesktopFocus(undefined, undefined)).toBe(false)
    expect(shouldSubmitDesktopFocus(undefined, 'request-1')).toBe(true)
    expect(shouldSubmitDesktopFocus('request-1', 'request-1')).toBe(false)
    expect(shouldSubmitDesktopFocus('request-1', 'request-2')).toBe(true)
  })
})
