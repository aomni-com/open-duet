import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentUploadScope, ROOT_UPLOAD_SCOPE } from './upload-scope'
import { UploadTokenCredential } from './upload-token'

const tempDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs.clear()
})

describe('upload token credential', () => {
  test('mints an opaque credential that verifies until its expiry', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-upload-token-'))
    tempDirs.add(stateDir)
    const credentials = new UploadTokenCredential(stateDir)

    const grant = await credentials.mint(ROOT_UPLOAD_SCOPE, 1_000, 5_000)

    expect(grant.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(grant.expiresAt).toBe(6_000)
    expect(await credentials.verify(ROOT_UPLOAD_SCOPE, grant.token, 5_999)).toBe(true)
    expect(await credentials.verify(ROOT_UPLOAD_SCOPE, grant.token, 6_000)).toBe(false)
  })

  test('persists only a 0600 hash that verifies after a gateway restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-upload-token-'))
    tempDirs.add(stateDir)
    const grant = await new UploadTokenCredential(stateDir).mint(ROOT_UPLOAD_SCOPE, 1_000, 5_000)
    const path = join(stateDir, 'upload-tokens', 'root.json')

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain(grant.token)
    expect(
      await new UploadTokenCredential(stateDir).verify(ROOT_UPLOAD_SCOPE, grant.token, 2_000),
    ).toBe(true)
  })

  test('persists independent live credentials for separate agent scopes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-upload-token-'))
    tempDirs.add(stateDir)
    const credentials = new UploadTokenCredential(stateDir)
    const scopeA = agentUploadScope('anchor-a')
    const scopeB = agentUploadScope('anchor-b')

    const grantA = await credentials.mint(scopeA, 1_000, 5_000)
    const grantB = await credentials.mint(scopeB, 2_000, 5_000)

    expect(await credentials.verify(scopeA, grantA.token, 2_500)).toBe(true)
    expect(await credentials.verify(scopeB, grantB.token, 2_500)).toBe(true)
    expect(await credentials.verify(scopeB, grantA.token, 2_500)).toBe(false)
  })
})
