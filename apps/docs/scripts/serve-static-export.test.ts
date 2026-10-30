import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createStaticExportServer } from './serve-static-export'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('docs static export server', () => {
  test('serves clean routes, static files, and the exported 404 page', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'duet-docs-static-'))
    roots.push(root)
    await mkdir(path.join(root, 'getting-started'), { recursive: true })
    await mkdir(path.join(root, '_next', 'static'), { recursive: true })
    await writeFile(path.join(root, 'index.html'), '<h1>Docs home</h1>')
    await writeFile(path.join(root, 'getting-started', 'index.html'), '<h1>Getting started</h1>')
    await writeFile(path.join(root, '_next', 'static', 'app.css'), 'body { color: navy; }')
    await writeFile(path.join(root, '404.html'), '<h1>Missing documentation</h1>')

    const server = createStaticExportServer({ root, hostname: '127.0.0.1', port: 0 })
    const origin = `http://${server.hostname}:${server.port}`

    try {
      for (const pathname of ['/getting-started', '/getting-started/']) {
        const response = await fetch(`${origin}${pathname}`)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('<h1>Getting started</h1>')
      }

      const asset = await fetch(`${origin}/_next/static/app.css`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toStartWith('text/css')
      expect(await asset.text()).toBe('body { color: navy; }')

      const missing = await fetch(`${origin}/not-a-doc`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe('<h1>Missing documentation</h1>')
    } finally {
      await server.stop(true)
    }
  })
})
