import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Strips what the reader is told from what the code does.
 *
 * Block comments go first so a `//` inside one cannot be mistaken for the
 * start of a line comment, and a line comment is only recognised where the
 * slashes open the line — `https://` in a string is code, not prose.
 */
function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n')
}

test('no-vm-layout-in-web: SPA source contains no VM drive-root knowledge', async () => {
  const forbidden = [['/home', 'exedev', 'drive'].join('/'), ['DRIVE', 'ROOT', 'PATH'].join('_')]
  const violations: string[] = []

  for await (const relativePath of new Bun.Glob('**/*.{js,jsx,ts,tsx}').scan({
    cwd: import.meta.dir,
    onlyFiles: true,
  })) {
    /* A test that proves a VM-absolute path survives the wire has to be able
       to write one down. The claim here is about what the shipped SPA knows,
       and a fixture is not shipped. */
    if (/\.test\.[cm]?[jt]sx?$/.test(relativePath)) continue
    const source = executableSource(await readFile(join(import.meta.dir, relativePath), 'utf8'))
    for (const token of forbidden) {
      if (source.includes(token)) violations.push(`${relativePath}: ${token}`)
    }
  }

  expect(violations).toEqual([])
})
