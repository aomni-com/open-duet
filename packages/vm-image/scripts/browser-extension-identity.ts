import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function createBrowserExtensionIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  })
  const id = createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))
  return { id, publicKey: publicKey.toString('base64'), privateKey }
}

/** Stage only into the disposable build context. The private key is a BuildKit secret. */
export async function stageBrowserExtension(directory: string, keyPath: string): Promise<void> {
  const identity = createBrowserExtensionIdentity()
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await Promise.all([
    writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, key: identity.publicKey }, null, 2) + '\n',
    ),
    writeFile(join(directory, 'id'), identity.id + '\n'),
    writeFile(keyPath, identity.privateKey, { mode: 0o600, flag: 'wx' }),
  ])
}
