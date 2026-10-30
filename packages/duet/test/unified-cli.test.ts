import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../src/cli.js'
import { configPathForHome, saveConfig } from '../src/config.js'
const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

test('explicit remote memory ignores the stored default and uses the same saved login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-dispatch-'))
  homes.push(home)
  await saveConfig(
    { apiKey: 'person-key', defaultWorkspace: 'harbor', apiUrl: 'https://api.test' },
    configPathForHome(home),
  )
  const requests: Array<{ url: string; key: string | null; body: unknown }> = []
  const output: string[] = []
  const result = await runCli(
    ['memory', 'add', 'the remote note', '--workspace', 'orchard', '--json'],
    {
      home,
      env: {},
      fetch: (async (url, init) => {
        requests.push({
          url: String(url),
          key: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({ id: 'remote-note', content: 'the remote note' })
      }),
      io: {
        stdout: { write: text => (output.push(String(text)), true) },
        stderr: { write: text => (output.push(String(text)), true) },
      },
    },
  )
  expect(result.exitCode).toBe(0)
  expect(requests).toEqual([
    {
      url: 'https://api.test/v1/ws/orchard/memories',
      key: 'Bearer person-key',
      body: { content: 'the remote note', source: 'user' },
    },
  ])
  expect(output.join('')).toBe('{"id":"remote-note","content":"the remote note"}\n')
})

test('help teaches one login and the complete merged command families', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-help-'))
  homes.push(home)
  let text = ''
  expect(
    (
      await runCli(['--help'], {
        home,
        env: {},
        io: {
          stdout: { write: chunk => ((text += String(chunk)), true) },
          stderr: { write: () => true },
        },
      })
    ).exitCode,
  ).toBe(0)
  for (const command of [
    'whoami',
    'push',
    'pull',
    'history',
    'seen-by',
    'workspace',
    'agent',
    'import',
    'billing',
    'sync',
  ])
    expect(text).toContain(`duet ${command}`)
  expect(text).toContain('--workspace')
  expect(text).toContain('config.json')
  expect(text).not.toContain('duetfs')
})

test('conflicting address and flag targets leave the destination untouched without an API request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-conflict-'))
  homes.push(home)
  const destination = join(home, 'saved.txt')
  await Bun.write(destination, 'keep these bytes')
  let requests = 0
  let error = ''
  const result = await runCli(
    ['pull', 'harbor:/saved.txt', destination, '--workspace', 'orchard', '--json'],
    {
      home,
      env: {},
      fetch: (async () => {
        requests++
        return new Response('wrong bytes')
      }),
      io: {
        stdout: { write: () => true },
        stderr: { write: text => ((error += String(text)), true) },
      },
    },
  )
  expect(result.exitCode).toBe(64)
  expect(error).toContain('different workspaces')
  expect(requests).toBe(0)
  expect(await Bun.file(destination).text()).toBe('keep these bytes')
})

test('the built CLI keeps memory and train local with a saved remote default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-local-mode-'))
  homes.push(home)
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    },
  })
  try {
    await saveConfig(
      { apiKey: 'person-key', defaultWorkspace: 'harbor', apiUrl: server.url.origin },
      configPathForHome(home),
    )
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      DUET_GATEWAY_BASE_URL: server.url.origin,
    }
    delete env.DUET_API_KEY
    delete env.DUET_API_URL
    delete env.DUET_WORKSPACE
    const entry = new URL('../dist/cli-entry.js', import.meta.url).pathname
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        'memory',
        'add',
        'a local note',
        '--store',
        join(home, 'notes'),
        '--json',
      ],
      { env, cwd: home, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).not.toContain('Fatal:')
    expect(code).toBe(0)
    const memory = JSON.parse(stdout)
    expect(memory.content).toBe('a local note')
    expect(await Bun.file(join(memory.store, `${memory.slug}.md`)).text()).toContain('a local note')
    const train = Bun.spawn([process.execPath, entry, 'train', join(home, 'missing-corpus')], {
      env,
      cwd: home,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [trainCode, trainError] = await Promise.all([
      train.exited,
      new Response(train.stderr).text(),
    ])
    expect(trainCode).toBe(1)
    expect(trainError).toContain('Folder not found or not a directory:')
    expect(requests).toBe(0)
  } finally {
    server.stop(true)
  }
}, 15_000)

test('remote-only commands can select a workspace through explicit environment input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-workspace-env-'))
  homes.push(home)
  await saveConfig(
    { apiKey: 'saved-key', defaultWorkspace: 'harbor', apiUrl: 'https://api.test' },
    configPathForHome(home),
  )
  const requests: string[] = []
  const result = await runCli(['billing', 'usage', '--json'], {
    home,
    env: { DUET_WORKSPACE: 'orchard' },
    fetch: (async url => {
      requests.push(String(url))
      return Response.json({ rows: [] })
    }),
    io: { stdout: { write: () => true }, stderr: { write: () => true } },
  })
  expect(result.exitCode).toBe(0)
  expect(requests).toEqual([
    'https://api.test/v1/ws/orchard/billing/usage?period=monthly&group=workspace',
  ])
})

test('the built entrypoint preserves a failed local resume exit status', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-failed-resume-'))
  homes.push(home)
  const child = Bun.spawn([process.execPath, new URL('../dist/cli-entry.js', import.meta.url).pathname, '--resume', 'missing-review-session', '--incognito', '--no-auto-upgrade'], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toContain('Unknown session')
  expect(code).toBe(1)
}, 15_000)

test('external upgrade preserves the package manager failure status', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-failed-upgrade-'))
  homes.push(home)
  const { chmod, mkdir } = await import('node:fs/promises')
  const bin = join(home, 'bin')
  await mkdir(bin)
  await Bun.write(join(bin, 'npm'), '#!/bin/sh\nexit 23\n')
  await chmod(join(bin, 'npm'), 0o755)
  const child = Bun.spawn([process.execPath, new URL('../dist/cli-entry.js', import.meta.url).pathname, 'upgrade', '--version', '1.0.0', '--manager', 'npm', '--force'], { cwd: home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toContain('Upgrading @duetso/agent to 1.0.0 with npm')
  expect(code).toBe(23)
}, 15_000)
