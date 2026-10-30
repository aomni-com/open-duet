import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const scriptPath = resolve(import.meta.dir, '../scripts/probe-browser-extension.ts')

describe('native browser extension probe', () => {
  test('keeps unsafe shortcuts out of the selected mechanism', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).not.toContain('--no-sandbox')
    expect(source).not.toContain('--disable-extensions-except')
    expect(source).not.toContain('--user-data-dir=/tmp')
  })
})
