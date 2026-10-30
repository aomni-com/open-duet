import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import type {
  DesktopSessionResponse,
  DesktopStatusResponse,
  FocusBrowserOwnerResult,
} from '@repo/contract'

import { createDesktopBackend } from './desktop-backend'
import {
  DESKTOP_IFRAME_ALLOW,
  DESKTOP_IFRAME_ALLOW_FULLSCREEN,
  DESKTOP_IFRAME_REFERRER_POLICY,
  DESKTOP_IFRAME_SANDBOX,
  createDesktopBrowserApi,
  fitDesktop,
} from './desktop-browser'
import type { DesktopFocusResult, DesktopSession, DesktopStatus } from './desktop-contract'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false
type Assert<Value extends true> = Value

export type PublicExampleMatchesCanonicalContract = [
  Assert<Equal<DesktopSession, DesktopSessionResponse>>,
  Assert<Equal<DesktopStatus, DesktopStatusResponse>>,
  Assert<Equal<DesktopFocusResult, FocusBrowserOwnerResult>>,
]

describe('public desktop example', () => {
  test('keeps the Duet API key on the backend while executing mint, status, and focus', async () => {
    const duetCalls: Request[] = []
    const browserCalls: Request[] = []
    const duetFetch = async (request: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(request, init)
      duetCalls.push(incoming)
      expect(incoming.headers.get('authorization')).toBe('Bearer duet_sk_server_only')
      if (incoming.url.endsWith('/desktop/session')) {
        expect(await incoming.json()).toEqual({ embedOrigin: 'https://customer.example' })
        return Response.json({
          entryUrl: 'https://vm.example/v1/desktop/grant.secret/',
          expiresAt: 1_800_000,
          phase: 'ready',
          screen: { width: 1440, height: 900 },
        })
      }
      if (incoming.url.endsWith('/desktop/status')) {
        return Response.json({ phase: 'ready', viewers: 1, owners: [] })
      }
      expect(incoming.url).toEndWith('/agents/root/desktop/focus')
      expect(await incoming.json()).toEqual({ requestId: 'focus-attempt-1' })
      return Response.json({ focused: true })
    }
    const backend = createDesktopBackend({
      duetApiUrl: 'https://ctl.duet.so',
      apiKey: 'duet_sk_server_only',
      workspaceSlug: 'acme',
      authorize: async () => true,
      fetch: duetFetch,
    })
    const browserFetch = async (request: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(new URL(String(request), 'https://customer.example'), init)
      browserCalls.push(incoming)
      return await backend(incoming)
    }
    const browser = createDesktopBrowserApi(browserFetch)

    const session = await browser.mint('https://customer.example')
    expect(session).toMatchObject({ phase: 'ready' })
    expect(session).not.toHaveProperty('token')
    expect(await browser.status()).toEqual({ phase: 'ready', viewers: 1, owners: [] })
    expect(await browser.focus('root', 'focus-attempt-1')).toEqual({ focused: true })
    expect(duetCalls).toHaveLength(3)
    expect(browserCalls.every(call => call.headers.get('authorization') === null)).toBe(true)
  })

  test('pins the product iframe policy and uniform, non-enlarging fit', () => {
    expect(DESKTOP_IFRAME_SANDBOX).toBe(
      'allow-same-origin allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads',
    )
    expect(DESKTOP_IFRAME_ALLOW).toBe('clipboard-read; clipboard-write')
    expect(DESKTOP_IFRAME_REFERRER_POLICY).toBe('no-referrer')
    expect(DESKTOP_IFRAME_ALLOW_FULLSCREEN).toBe(true)
    expect(fitDesktop({ width: 720, height: 900 }, { width: 1440, height: 900 })).toEqual({
      left: 0,
      top: 225,
      width: 720,
      height: 450,
      scale: 0.5,
    })
    expect(fitDesktop({ width: 2880, height: 1800 }, { width: 1440, height: 900 }).scale).toBe(1)
  })

  test('contains no browser credential or expiry-driven renewal path', async () => {
    const source = await readFile(new URL('./desktop-browser.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/authorization|apiKey|DUET_API_KEY/)
    expect(source).not.toContain('expiresAt')
    expect(source).not.toContain('setTimeout')
    expect(source).toContain("window.addEventListener('online', reconnectWhenOnline)")
    expect(source).toContain('refreshStatus().catch(reportError)')
  })
})
