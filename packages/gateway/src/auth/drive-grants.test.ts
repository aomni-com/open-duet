import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DriveGrants, type DriveGrantPermit } from './drive-grants'

const tempDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs.clear()
})

describe('drive grants', () => {
  test('authorizes PUT and DELETE inside the granted path prefix until expiry', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const grants = new DriveGrants(stateDir)

    const grant = await grants.mintUpload({
      pathPrefix: 'agents/a/uploads',
      actor: 'api-key:key_123',
      now: 1_000,
      ttlMs: 5_000,
    })

    expect(grant.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(grant.expiresAt).toBe(6_000)
    expect(await grants.authorize(grant.token, 'PUT', 'agents/a/uploads/file.pdf', 5_999)).toEqual({
      kind: 'upload',
      actor: 'api-key:key_123',
    })
    expect(
      await grants.authorize(grant.token, 'DELETE', 'agents/a/uploads/file.pdf', 5_999),
    ).toEqual({ kind: 'upload', actor: 'api-key:key_123' })
    expect(
      await grants.authorize(grant.token, 'GET', 'agents/a/uploads/file.pdf', 5_999),
    ).toBeNull()
    expect(
      await grants.authorize(grant.token, 'PUT', 'agents/a/uploads-other/file.pdf', 5_999),
    ).toBeNull()
    expect(
      await grants.authorize(grant.token, 'PUT', 'agents/a/uploads/file.pdf', 6_000),
    ).toBeNull()
  })

  test('authorizes GET and HEAD only for the exact download path and returns its actor', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const grants = new DriveGrants(stateDir)
    const grant = await grants.mintDownload({
      path: 'mcp/generated-media/video.mp4',
      actor: 'api-key:key_123',
      now: 1_000,
      ttlMs: 5_000,
    })

    const expectedPermit: DriveGrantPermit = { kind: 'download', actor: 'api-key:key_123' }
    expect(
      await grants.authorize(grant.token, 'GET', 'mcp/generated-media/video.mp4', 2_000),
    ).toEqual(expectedPermit)
    expect(
      await grants.authorize(grant.token, 'HEAD', 'mcp/generated-media/video.mp4', 2_000),
    ).toEqual(expectedPermit)
    expect(
      await grants.authorize(grant.token, 'GET', 'mcp/generated-media/other.mp4', 2_000),
    ).toBeNull()
    expect(
      await grants.authorize(grant.token, 'GET', 'mcp/generated-media/video.mp4/child', 2_000),
    ).toBeNull()
    expect(
      await grants.authorize(grant.token, 'PUT', 'mcp/generated-media/video.mp4', 2_000),
    ).toBeNull()
  })

  test('refuses to mint grants with an invalid encoded actor', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)

    await expect(
      new DriveGrants(stateDir).mintDownload({
        path: 'mcp/generated-media/video.mp4',
        actor: 'untrusted actor',
        now: 1_000,
      }),
    ).rejects.toThrow('Invalid drive grant')
    await expect(
      new DriveGrants(stateDir).mintUpload({
        pathPrefix: 'mcp/generated-media',
        actor: 'untrusted actor',
        now: 1_000,
      }),
    ).rejects.toThrow('Invalid drive grant')
  })

  test('keeps concurrent grants for the same prefix independently live', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const grants = new DriveGrants(stateDir)

    const first = await grants.mintUpload({
      pathPrefix: 'uploads',
      actor: 'system',
      now: 1_000,
      ttlMs: 5_000,
    })
    const second = await grants.mintUpload({
      pathPrefix: 'uploads',
      actor: 'system',
      now: 2_000,
      ttlMs: 5_000,
    })

    expect(await grants.authorize(first.token, 'PUT', 'uploads/first.txt', 2_500)).toEqual({
      kind: 'upload',
      actor: 'system',
    })
    expect(await grants.authorize(second.token, 'PUT', 'uploads/second.txt', 2_500)).toEqual({
      kind: 'upload',
      actor: 'system',
    })
  })

  test('prunes expired grant records when minting the next grant', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const grants = new DriveGrants(stateDir)

    await grants.mintUpload({
      pathPrefix: 'uploads',
      actor: 'system',
      now: 1_000,
      ttlMs: 1_000,
    })
    const live = await grants.mintDownload({
      path: 'mcp/generated-media/live.mp4',
      actor: 'web:user_1',
      now: 2_000,
      ttlMs: 5_000,
    })

    expect(await readdir(join(stateDir, 'drive-grants'))).toEqual([
      `${createHash('sha256').update(live.token).digest('hex')}.json`,
    ])
    expect(
      await grants.authorize(live.token, 'GET', 'mcp/generated-media/live.mp4', 2_000),
    ).toEqual({ kind: 'download', actor: 'web:user_1' })
  })

  test('removes an expired grant record when it is presented', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const grants = new DriveGrants(stateDir)
    const expired = await grants.mintDownload({
      path: 'mcp/generated-media/late.mp4',
      actor: 'session:agent_1',
      now: 1_000,
      ttlMs: 1_000,
    })

    expect(
      await grants.authorize(expired.token, 'GET', 'mcp/generated-media/late.mp4', 2_000),
    ).toBeNull()
    expect(await readdir(join(stateDir, 'drive-grants'))).toEqual([])
  })

  test('persists only a 0600 token hash and survives a gateway restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const grant = await new DriveGrants(stateDir).mintDownload({
      path: 'mcp/generated-media/restarted.mp4',
      actor: 'api-key:key_123',
      now: 1_000,
      ttlMs: 5_000,
    })
    const digest = createHash('sha256').update(grant.token).digest('hex')
    const path = join(stateDir, 'drive-grants', `${digest}.json`)

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain(grant.token)
    expect(
      await new DriveGrants(stateDir).authorize(
        grant.token,
        'GET',
        'mcp/generated-media/restarted.mp4',
        2_000,
      ),
    ).toEqual({ kind: 'download', actor: 'api-key:key_123' })
  })

  test('refuses to persist grants through a symlinked state directory', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-drive-grants-'))
    tempDirs.add(stateDir)
    const outside = join(stateDir, 'outside')
    await mkdir(outside)
    await symlink(outside, join(stateDir, 'drive-grants'))

    await expect(
      new DriveGrants(stateDir).mintUpload({
        pathPrefix: 'uploads',
        actor: 'system',
        now: 1_000,
      }),
    ).rejects.toThrow('must not be a symlink')
    expect(await readdir(outside)).toEqual([])
  })
})
