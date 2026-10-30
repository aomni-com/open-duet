import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'

import { freeLoopbackPort, reposMissingRemoteUnder } from './mirror.js'

const tmpDirs: string[] = []
afterAll(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-mirror-'))
  tmpDirs.push(dir)
  return dir
}

async function makeRepo(root: string, rel: string, config: string): Promise<void> {
  const gitDir = join(root, rel, '.git')
  await mkdir(gitDir, { recursive: true })
  await writeFile(join(gitDir, 'config'), config, 'utf8')
}

describe('reposMissingRemoteUnder (G1 nag, read-only)', () => {
  const WITH_REMOTE = '[core]\n[remote "origin"]\n\turl = git@example.com:me/x.git\n'
  const NO_REMOTE = '[core]\n\tbare = false\n'

  test('flags a root repo with no remote', async () => {
    const dir = await makeDir()
    await makeRepo(dir, '.', NO_REMOTE)
    expect(await reposMissingRemoteUnder(dir)).toEqual(['.'])
  })

  test('a repo with a remote is not flagged', async () => {
    const dir = await makeDir()
    await makeRepo(dir, '.', WITH_REMOTE)
    expect(await reposMissingRemoteUnder(dir)).toEqual([])
  })

  test('scans immediate children and names the remoteless one', async () => {
    const dir = await makeDir()
    await makeRepo(dir, 'api', NO_REMOTE)
    await makeRepo(dir, 'web', WITH_REMOTE)
    await mkdir(join(dir, 'docs'), { recursive: true }) // no .git — ignored
    expect(await reposMissingRemoteUnder(dir)).toEqual(['api'])
  })

  test('a dir with no repos at all is clean', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'README.md'), '# hi', 'utf8')
    expect(await reposMissingRemoteUnder(dir)).toEqual([])
  })
})

describe('freeLoopbackPort', () => {
  test('allocates distinct usable loopback ports', async () => {
    const listening: Server[] = []
    const bind = async (port: number) => {
      const server = createServer()
      listening.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
    }
    try {
      const a = await freeLoopbackPort()
      await bind(a)
      const b = await freeLoopbackPort()
      await bind(b)
      expect(b).not.toBe(a)
    } finally {
      await Promise.all(
        listening.map(server => new Promise<void>(resolve => server.close(() => resolve()))),
      )
    }
  })
})
