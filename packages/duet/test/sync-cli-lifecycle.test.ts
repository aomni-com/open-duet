import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { SyncMachineRegisterRequestSchema, type SyncMachine } from '@repo/contract'

const entry = new URL('../dist/cli-entry.js', import.meta.url).pathname

test('the built sync CLI installs, reports status and uninstalls without losing login or mirrored files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-sync-cli-'))
  const bin = join(home, 'bin')
  const configPath = join(home, '.duet', 'config.json')
  const loadedPath = join(home, 'launchctl.loaded')
  const identityPath = join(home, '.duet', 'sync', 'identity')
  let machine: SyncMachine | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer fixture-person-key')
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      if (new URL(request.url).pathname !== '/v1/user/sync-machines' || request.method !== 'POST')
        return Response.json({ error: 'unexpected_request' }, { status: 404 })
      const parsed = SyncMachineRegisterRequestSchema.safeParse(await request.json())
      if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })
      machine ??= { machineId: 'fixture-mac', ...parsed.data, createdAt: 1, lastUsedAt: 1 }
      return Response.json(machine)
    },
  })
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    DUET_SYNCTHING_BIN: join(bin, 'syncthing'),
  }
  const transcript: Array<{ args: string[]; exitCode: number; stdout: string; stderr: string }> = []
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, entry, 'sync', ...args], {
      env,
      cwd: home,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    transcript.push({ args: ['duet', 'sync', ...args], exitCode, stdout, stderr })
    expect(exitCode, stderr).toBe(0)
    expect(stdout + stderr).not.toContain('fixture-person-key')
    return { stdout, stderr }
  }
  try {
    await mkdir(bin)
    await mkdir(dirname(configPath), { recursive: true })
    const login = {
      apiKey: 'fixture-person-key',
      apiUrl: server.url.origin,
      defaultWorkspace: 'studio',
    }
    await Bun.write(configPath, JSON.stringify(login))
    await Bun.write(
      join(bin, 'launchctl'),
      `#!/bin/sh
case "$1" in
  bootstrap) : > "$HOME/launchctl.loaded" ;;
  bootout)
    if test -f "$HOME/launchctl.loaded"; then rm "$HOME/launchctl.loaded"; else exit 3; fi
    ;;
  *) exit 64 ;;
esac
`,
    )
    await Bun.write(
      join(bin, 'syncthing'),
      `#!/bin/sh
case "$1" in
  --version) printf 'syncthing v2.1.2 fixture\\n' ;;
  generate)
    sync_home="\${2#--home=}"
    printf 'fixture-certificate:%s' "$sync_home" > "$sync_home/cert.pem"
    printf 'fixture-private-key:%s' "$sync_home" > "$sync_home/key.pem"
    ;;
  device-id) printf 'AAAAAAA-BBBBBBB\\n' ;;
  *) exit 64 ;;
esac
`,
    )
    await Promise.all(['launchctl', 'syncthing'].map(name => chmod(join(bin, name), 0o700)))
    const mirrored = join(home, 'duet', 'studio', 'keep.txt')
    await mkdir(dirname(mirrored), { recursive: true })
    await Bun.write(mirrored, 'mirrored user bytes')
    const unrelatedAgent = join(home, 'Library', 'LaunchAgents', 'fixture-other.plist')
    await mkdir(dirname(unrelatedAgent), { recursive: true })
    await Bun.write(unrelatedAgent, 'unrelated launch agent')

    expect(JSON.parse((await run('status', '--json')).stdout)).toEqual({
      ok: false,
      running: false,
      workspaces: [],
    })
    const installed = JSON.parse((await run('install', '--json')).stdout)
    expect(installed).toMatchObject({
      ok: true,
      machineId: 'fixture-mac',
      label: 'so.duet.sync',
      syncthing: 'v2.1.2',
    })
    expect(installed.plist).toBe(join(home, 'Library', 'LaunchAgents', 'so.duet.sync.plist'))
    expect(await Bun.file(loadedPath).exists()).toBe(true)
    const plist = await readFile(installed.plist, 'utf8')
    expect(plist).toContain(`<string>${entry}</string>`)
    expect(plist).toContain('<string>sync</string>\n      <string>daemon</string>')
    expect(await Bun.file(configPath).json()).toEqual({ ...login, machineId: 'fixture-mac' })
    const certificate = await readFile(join(identityPath, 'cert.pem'), 'utf8')
    expect(certificate).toStartWith('fixture-certificate:')
    const privateKey = await readFile(join(identityPath, 'key.pem'), 'utf8')

    expect((await run('install')).stdout).toContain("Check it with 'duet sync status'")
    expect(await readFile(installed.plist, 'utf8')).toBe(plist)
    expect(await readFile(join(identityPath, 'cert.pem'), 'utf8')).toBe(certificate)
    expect(await Bun.file(configPath).json()).toEqual({ ...login, machineId: 'fixture-mac' })

    // The daemon owns this filesystem edge. The launcher fixture does not start a service.
    const snapshot = {
      version: 1,
      updatedAt: Date.now(),
      daemonPid: 123,
      workspaces: [
        {
          slug: 'studio',
          state: 'up-to-date',
          localDir: dirname(mirrored),
          connected: true,
          needBytes: 0,
          remoteCompletion: 100,
          conflicts: 0,
        },
      ],
    }
    await Bun.write(join(home, '.duet', 'sync', 'status.json'), JSON.stringify(snapshot))
    expect(JSON.parse((await run('status', '--json')).stdout)).toEqual({
      ok: true,
      running: true,
      ...snapshot,
    })
    expect((await run('status')).stdout).toContain('studio  up to date')

    expect(JSON.parse((await run('uninstall', '--json')).stdout)).toEqual({
      ok: true,
      label: 'so.duet.sync',
      wasLoaded: true,
    })
    expect(await Bun.file(installed.plist).exists()).toBe(false)
    expect(await Bun.file(loadedPath).exists()).toBe(false)
    expect(JSON.parse((await run('uninstall', '--json')).stdout)).toEqual({
      ok: true,
      label: 'so.duet.sync',
      wasLoaded: false,
    })
    expect((await run('uninstall')).stdout).toContain('was not installed; nothing to do')
    expect(await Bun.file(configPath).json()).toEqual({ ...login, machineId: 'fixture-mac' })
    expect(await readFile(join(identityPath, 'cert.pem'), 'utf8')).toBe(certificate)
    expect(await readFile(mirrored, 'utf8')).toBe('mirrored user bytes')
    expect(await readFile(unrelatedAgent, 'utf8')).toBe('unrelated launch agent')
    expect(await readFile(join(identityPath, 'key.pem'), 'utf8')).toBe(privateKey)
    expect(machine?.syncthingDeviceId).toBe('AAAAAAA-BBBBBBB')
    console.log(JSON.stringify(transcript, null, 2))
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)
