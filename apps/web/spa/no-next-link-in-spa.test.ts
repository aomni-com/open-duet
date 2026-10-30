import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The SPA routes with react-router; Next's client router does not own these
 * paths. A `next/link` pushes the URL without a popstate, so react-router never
 * hears it and the destination never renders — the link reads as dead. Link
 * with react-router's `Link`, or a plain `<a>` when a full reload is intended.
 */
test('no-next-link-in-spa: SPA source links with react-router, never next/link', async () => {
  const violations: string[] = []

  for await (const relativePath of new Bun.Glob('**/*.{js,jsx,ts,tsx}').scan({
    cwd: import.meta.dir,
    onlyFiles: true,
  })) {
    if (relativePath.includes('.test.')) continue
    const source = await readFile(join(import.meta.dir, relativePath), 'utf8')
    if (source.includes("from 'next/link'")) violations.push(relativePath)
  }

  expect(violations).toEqual([])
})
