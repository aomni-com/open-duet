import { expect, test } from 'bun:test'
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stageBrowserExtension } from '../scripts/browser-extension-identity'

test('independent image builds generate matching extension identities without changing source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-extension-build-'))
  const source = join(import.meta.dir, '../desktop/chrome-extension')
  const before = await readFile(join(source, 'manifest.json'), 'utf8')
  try {
    const ids: string[] = []
    for (const name of ['first', 'second']) {
      const directory = join(root, name, 'source')
      const keyPath = join(root, name, 'signing-key.pem')
      await cp(source, directory, { recursive: true })
      await stageBrowserExtension(directory, keyPath)
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      const privateKey = await readFile(keyPath, 'utf8')
      const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      expect(manifest.key).toBe(publicKey.toString('base64'))
      expect(manifest.permissions).toEqual(['tabs', 'windows', 'debugger'])
      expect((await readdir(directory)).some(name => name.endsWith('.pem'))).toBe(false)
      const id = (await readFile(join(directory, 'id'), 'utf8')).trim()
      expect(id).toBe(
        createHash('sha256')
          .update(publicKey)
          .digest('hex')
          .slice(0, 32)
          .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16))),
      )
      expect(
        verify(
          'sha256',
          Buffer.from('build proof'),
          createPublicKey(privateKey),
          sign('sha256', Buffer.from('build proof'), privateKey),
        ),
      ).toBe(true)
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
      ids.push(id)
    }
    expect(ids[0]).not.toBe(ids[1])
    expect(await readFile(join(source, 'manifest.json'), 'utf8')).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
