import { test } from 'bun:test'

import { chromium, expect, type Browser } from '@playwright/test'

import { DUET_APP_ACCESS_QUERY, mintAppAccessGrant } from '@repo/contract'

import { createEdgeApp } from '../src/index'

test('launch replaces cached iframe HTML and subsequent edits refresh unchanged asset URLs', async () => {
  let revision = 'Old homepage'
  let legacy = true
  let scriptPath = '/app-old.js'
  const host = 'home--workspace.edge.duet.so'
  const content = (path: string) =>
    new Response(
      path.endsWith('.js')
        ? `document.querySelector('h1').textContent += ' / ${revision} script'`
        : `<h1>${revision}</h1><script src="${scriptPath}"></script>`,
      {
        headers: {
          'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html',
          'cache-control': 'public, max-age=31536000',
        },
      },
    )
  const edge = createEdgeApp({
    convexSiteUrl: 'https://convex.example',
    edgeSecret: 'cache-test',
    fetch: async input => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/edge/resolve') {
        return Response.json({
          visibility: 'public',
          workspace: {
            id: 'ws-id',
            slug: 'workspace',
            httpsUrl: 'https://vm.example',
            vmName: 'vm',
          },
          origin: {
            httpsUrl: 'https://vm.example',
            gatewayAuthToken: 'vm-token',
            gatewayPathPrefix: '/public/app',
          },
        })
      }
      return content(url.pathname.replace('/public/app', '') || '/')
    },
  })
  // Localhost is a trustworthy browser origin. Adapt only transport addresses;
  // route parsing, grant exchange, response policy and redirects are production.
  const appServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (legacy) return content(url.pathname)
      const response = await edge.fetch(
        new Request(`https://${host}${url.pathname}${url.search}`, {
          headers: { ...Object.fromEntries(request.headers), host },
        }),
      )
      const location = response.headers.get('location')
      if (location !== null) {
        const target = new URL(location)
        response.headers.set(
          'location',
          `${appServer.url.origin}${target.pathname}${target.search}`,
        )
      }
      return response
    },
  })
  let grant = ''
  const shell = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        `<iframe title="Homepage" sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" src="${appServer.url.origin}/${grant ? `?${DUET_APP_ACCESS_QUERY}=${grant}` : ''}"></iframe>`,
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } },
      ),
  })
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(shell.url.toString())
    const heading = page.frameLocator('iframe').locator('h1')
    await expect(heading).toHaveText('Old homepage / Old homepage script')
    await heading.evaluate(() => {
      localStorage.setItem('saved-input', 'keep my work')
      document.cookie = 'app-preference=keep'
    })
    revision = 'New homepage'
    // Migrating an app with old long-lived assets follows build-apps: use a
    // new asset URL once, because HTTP cache clearing cannot evict every
    // browser's renderer memory. Subsequent edits keep that same URL below.
    scriptPath = '/app-new.js'
    legacy = false
    // The clean document URL has already been warmed, as in an
    // existing user's browser before the policy change.
    grant = await mintAppAccessGrant('cache-test', {
      appId: 'app-id',
      userId: 'user-id',
      workspaceSlug: 'workspace',
      appSlug: 'home',
      launchExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
      nonce: '0123456789abcdef0123456789abcdef',
    })
    await page.reload()
    await expect(heading).toHaveText('New homepage / New homepage script')
    expect(await heading.evaluate(() => localStorage.getItem('saved-input'))).toBe('keep my work')
    expect(await heading.evaluate(() => document.cookie)).toContain('app-preference=keep')
    revision = 'Next homepage'
    await page.reload()
    await expect(heading).toHaveText('Next homepage / Next homepage script')
  } finally {
    await browser?.close()
    shell.stop(true)
    appServer.stop(true)
  }
})
