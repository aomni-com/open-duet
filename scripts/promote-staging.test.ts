import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('promotes staging through a temporary worktree without changing the caller worktree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duet-promote-staging-test-'))
  temporaryDirectories.push(root)
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  const caller = path.join(root, 'caller')

  await git(root, 'init', '--bare', remote)
  await git(root, 'init', seed)
  await git(seed, 'config', 'user.name', 'Promotion Test')
  await git(seed, 'config', 'user.email', 'promotion@example.test')
  await writeFile(path.join(seed, 'main.txt'), 'main\n')
  await git(seed, 'add', 'main.txt')
  await git(seed, 'commit', '-m', 'main')
  await git(seed, 'branch', '-M', 'main')
  await git(seed, 'remote', 'add', 'origin', remote)
  await git(seed, 'push', '-u', 'origin', 'main')
  await git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(seed, 'switch', '-c', 'staging')
  await writeFile(path.join(seed, 'staging.txt'), 'staging\n')
  await git(seed, 'add', 'staging.txt')
  await git(seed, 'commit', '-m', 'staging')
  const stagingTip = await git(seed, 'rev-parse', 'HEAD')
  await git(seed, 'push', '-u', 'origin', 'staging')

  await git(root, 'clone', remote, caller)
  await git(caller, 'config', 'user.name', 'Caller')
  await git(caller, 'config', 'user.email', 'caller@example.test')
  await writeFile(path.join(caller, 'main.txt'), 'session WIP\n')
  await writeFile(path.join(caller, 'untracked.txt'), 'keep me\n')
  const before = await git(caller, 'status', '--porcelain=v1')

  const result = Bun.spawnSync(
    ['bun', path.join(import.meta.dir, 'promote-staging.ts'), `--remote=${remote}`],
    { cwd: caller, stdout: 'pipe', stderr: 'pipe' },
  )
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)

  expect(await git(caller, 'status', '--porcelain=v1')).toBe(before)
  expect(await readFile(path.join(caller, 'main.txt'), 'utf8')).toBe('session WIP\n')
  expect(await readFile(path.join(caller, 'untracked.txt'), 'utf8')).toBe('keep me\n')

  const mainTip = await git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main')
  const parents = (
    await git(root, '--git-dir', remote, 'show', '-s', '--format=%P', mainTip)
  ).split(' ')
  expect(parents).toHaveLength(2)
  expect(parents[1]).toBe(stagingTip)
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}
