import assert from 'node:assert/strict'

import type { Frame, Page, WebSocket as PlaywrightWebSocket } from '@playwright/test'

import {
  DesktopSessionResponseSchema,
  DesktopStatusResponseSchema,
  UserApiKeyIssuedSchema,
  type DesktopSessionResponse,
} from '@repo/contract'

import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import type { WorkspaceBrowserJourneyContext } from './staging-live-workspace-browser.ts'

const DESKTOP_WAIT_MS = 180_000

export interface PublicDesktopAcceptance {
  credentialKey: string
  session: DesktopSessionResponse
  frame: Frame
  socket: PlaywrightWebSocket
  evidence: {
    responseKeys: string[]
    phase: string
    screen: { width: number; height: number }
  }
}

export function publicDesktopSessionEvidence(response: Record<string, unknown>): {
  expiresAt: number
  phase: string
  screen: { width: number; height: number }
  responseKeys: string[]
} {
  const parsed = DesktopSessionResponseSchema.parse(response)
  return {
    expiresAt: parsed.expiresAt,
    phase: parsed.phase,
    screen: parsed.screen,
    responseKeys: Object.keys(response).sort(),
  }
}

export function publicDesktopProbeUrl(appUrl: string): string {
  return new URL('/__duet-desktop-embed-probe', appUrl).href
}

export async function startPublicDesktopAcceptance(
  context: WorkspaceBrowserJourneyContext,
  waitForPixels: (frame: Frame) => Promise<unknown>,
): Promise<PublicDesktopAcceptance> {
  const credentialKey = await issueSessionsApiCredential(context)
  const sessionRaw = await apiJson<Record<string, unknown>>(
    `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/desktop/session`,
    {
      method: 'POST',
      headers: bearerJson(credentialKey),
      body: JSON.stringify({ embedOrigin: new URL(context.env.appUrl).origin }),
    },
    200,
    'public desktop session',
    context.artifacts,
  )
  const session = DesktopSessionResponseSchema.parse(sessionRaw)
  const evidence = publicDesktopSessionEvidence(sessionRaw)
  assert.deepEqual(evidence.responseKeys, ['entryUrl', 'expiresAt', 'phase', 'screen'])
  const { frame, socket } = await mountPublicDesktopFrame(
    context.page,
    context.env.appUrl,
    session.entryUrl,
  )
  await waitForPixels(frame)
  await frame
    .locator('#noVNC_container canvas')
    .first()
    .click({ position: { x: 100, y: 100 } })
  await context.page.keyboard.press('Escape')
  await assertWrongOriginFrameRefused(context.page, session.entryUrl)
  const viewers = DesktopStatusResponseSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/desktop/status`,
      { headers: bearer(credentialKey) },
      200,
      'public desktop status',
      context.artifacts,
    ),
  ).viewers
  assert(viewers >= 1, 'public status did not report a live viewer')
  assert.equal(socket.isClosed(), false, 'public iframe viewer socket closed after admission')
  return { credentialKey, session, frame, socket, evidence }
}

export async function assertPublicDesktopAdmissionExpiry(
  acceptance: PublicDesktopAcceptance,
): Promise<void> {
  const remainingMs = acceptance.session.expiresAt - Date.now() + 1_000
  if (remainingMs > 0) await Bun.sleep(remainingMs)
  const expired = await stagingFetch(acceptance.session.entryUrl, { redirect: 'manual' })
  assert.equal(expired.status, 401, 'expired public desktop URL admitted a new viewer')
  assert.equal(
    acceptance.socket.isClosed(),
    false,
    'the specifically admitted public viewer socket closed when only its grant expired',
  )
}

async function issueSessionsApiCredential(
  context: WorkspaceBrowserJourneyContext,
): Promise<string> {
  const issued = UserApiKeyIssuedSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/user/api-keys`,
      {
        method: 'POST',
        headers: bearerJson(context.apiToken),
        body: JSON.stringify({
          workspaceSlug: context.workspace.slug,
          name: `Desktop staging ${context.runId}`,
          capabilities: ['sessions'],
        }),
      },
      201,
      'issue desktop sessions API credential',
      context.artifacts,
    ),
  )
  context.ledger.record({
    kind: 'api-key',
    id: issued.record.id,
    label: `${context.runId}:desktop-api-key:${issued.record.id}`,
    cleanup: async () =>
      await apiJson(
        `${context.env.apiUrl}/v1/user/api-keys/${encodeURIComponent(issued.record.id)}`,
        { method: 'DELETE', headers: bearer(context.apiToken) },
        200,
        'revoke desktop sessions API credential',
        context.artifacts,
      ),
    verify: async () => {
      const response = await stagingFetch(
        `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/desktop/status`,
        { headers: bearer(issued.key) },
      )
      return response.status === 401
    },
  })
  return issued.key
}

async function mountPublicDesktopFrame(
  sourcePage: Page,
  appUrl: string,
  entryUrl: string,
): Promise<{ frame: Frame; socket: PlaywrightWebSocket }> {
  const viewer = await sourcePage.context().newPage()
  const probeUrl = publicDesktopProbeUrl(appUrl)
  await viewer.route(
    probeUrl,
    async route =>
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<main><iframe id="public-desktop"></iframe></main>',
      }),
    { times: 1 },
  )
  await viewer.goto(probeUrl, { waitUntil: 'domcontentloaded' })
  const socketPromise = viewer.waitForEvent('websocket', {
    predicate: socket => {
      try {
        return new URL(socket.url()).pathname.endsWith('/websockify')
      } catch {
        return false
      }
    },
    timeout: DESKTOP_WAIT_MS,
  })
  await viewer.locator('#public-desktop').evaluate((element, source) => {
    const frame = element as HTMLIFrameElement
    frame.width = '1440'
    frame.height = '900'
    frame.allow = 'clipboard-read; clipboard-write'
    frame.src = source
  }, entryUrl)
  const expected = new URL(entryUrl)
  const deadline = Date.now() + DESKTOP_WAIT_MS
  for (;;) {
    const frame = viewer.frames().find(candidate => {
      try {
        const actual = new URL(candidate.url())
        return actual.origin === expected.origin && actual.pathname === expected.pathname
      } catch {
        return false
      }
    })
    if (frame !== undefined) return { frame, socket: await socketPromise }
    if (Date.now() >= deadline) throw new Error('public desktop iframe did not connect')
    await Bun.sleep(250)
  }
}

async function assertWrongOriginFrameRefused(sourcePage: Page, entryUrl: string): Promise<void> {
  const browser = sourcePage.context().browser()
  assert(browser !== null, 'browser closed before wrong-origin CSP probe')
  const isolated = await browser.newContext()
  const wrong = await isolated.newPage()
  let refused = false
  wrong.on('console', message => {
    if (/frame-ancestors|refused to frame/i.test(message.text())) refused = true
  })
  try {
    await wrong.setContent('<iframe id="wrong-origin"></iframe>')
    await wrong.locator('#wrong-origin').evaluate((element, source) => {
      ;(element as HTMLIFrameElement).src = source
    }, entryUrl)
    const deadline = Date.now() + 10_000
    while (!refused && Date.now() < deadline) await Bun.sleep(100)
    assert(refused, 'wrong-origin parent was not refused by browser frame-ancestors CSP')
  } finally {
    await isolated.close()
  }
}
