import { createHash } from 'node:crypto'

import { Hono } from 'hono'

import {
  DesktopSessionRequestSchema,
  desktopCredentialPath,
  desktopViewerPath,
} from '@repo/contract'

import {
  createDesktopIngress,
  desktopWebSocketHandlers,
  handleDesktopUpgrade,
  type DesktopSocketData,
} from '../routes/desktop'
import { createWebSocketRouter, runWebSocketUpgradeHandlers } from '../runtime/ws-router'

const grantId = 'kg2-browser'
const token = 'kg2_browser_secret'
let viewers = 0
const ingress = createDesktopIngress({
  readKasmCredential: async () => {
    const response = await Bun.file('/home/exedev/.duet/desktop/kasm-auth.json').json()
    return response as { username: string; password: string }
  },
  lifecycle: {
    async ensureStarted() {
      return 'ready'
    },
    phase: () => 'ready',
    viewerAttached() {
      viewers += 1
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        viewers -= 1
      }
    },
    viewerCount: () => viewers,
  },
})
const app = new Hono()
app.route('/v1/desktop', ingress.routes)
app.post('/kg2-grant', async c => {
  const body = DesktopSessionRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'invalid_request' }, 400)
  const result = ingress.grants.put(grantId, {
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    expiresAt: Date.now() + 10 * 60 * 1000,
    payload: body.data,
  })
  return result.ok ? c.json({ ok: true }) : c.json({ error: 'desktop_unavailable' }, 503)
})
app.get('/kg2-entry', c => c.json({ entryPath: desktopCredentialPath(grantId, token) }))
app.get('/kg2-host', c =>
  c.html(
    `<iframe title="Desktop" src="${desktopViewerPath(grantId, token)}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>`,
  ),
)

let server: Bun.Server<DesktopSocketData>
server = Bun.serve<DesktopSocketData>({
  hostname: '0.0.0.0',
  port: Number(process.env.PORT ?? '3000'),
  idleTimeout: 255,
  async fetch(request) {
    const upgraded = await runWebSocketUpgradeHandlers(request, [
      candidate => handleDesktopUpgrade(candidate, server, ingress),
    ])
    return upgraded === null ? app.fetch(request) : upgraded
  },
  websocket: createWebSocketRouter<DesktopSocketData>({
    desktop: desktopWebSocketHandlers(),
  }),
})

console.log(`desktop render harness listening on ${server.url}`)
