import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'

test('public docs use the unified CLI and one human login', async () => {
  const root = path.resolve(import.meta.dir, '../app')
  const obsolete: Array<{ file: string; text: string }> = []
  for await (const file of new Glob('**/page.mdx').scan(root)) {
    const source = await readFile(path.join(root, file), 'utf8')
    for (const match of source.matchAll(
      /duetfs|login --sync|sync-device credential|user:files:(?:read|write)/g,
    ))
      obsolete.push({ file, text: match[0] })
  }
  expect(obsolete).toEqual([])
  const sync = await readFile(path.join(root, 'sync/page.mdx'), 'utf8')
  expect(sync).toContain('npm install -g @duetso/agent')
  expect(sync).toContain('Bun 1.3.14')
  expect(sync).toContain('duet login')
  expect(sync).toContain('duet sync install')
})
