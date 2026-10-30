import { afterAll, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FetchLike } from '@repo/contract'

import { createCommandContext } from '../cli-support.js'
import { configPathForHome, loadConfig, saveConfig } from '../config.js'
import {
  isSyncMachineActive,
  macIdentityHome,
  prepareMacIdentity,
  registerSyncMachine,
} from './machine.js'

const homes: string[] = []
afterAll(async () => {
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
})

async function scratch(): Promise<{ home: string; binary: string }> {
  const home = await mkdtemp(join(tmpdir(), 'duet-machine-'))
  homes.push(home)
  const binary = join(home, 'syncthing')
  await writeFile(
    binary,
    `#!/bin/sh
sync_home="\${2#--home=}"
case "$1" in
  generate)
    printf '%s' "$sync_home" > "$sync_home/cert.pem"
    printf '%s' "$sync_home-key" > "$sync_home/key.pem"
    ;;
  device-id) printf 'AAAAAAA-BBBBBBB\\n' ;;
  *) exit 1 ;;
esac
`,
  )
  await chmod(binary, 0o700)
  return { home, binary }
}

test('explicit registration reuses the Mac identity and canonical machine ID after key replacement', async () => {
  const { home, binary } = await scratch()
  const path = configPathForHome(home)
  await saveConfig(
    { apiKey: 'key-one', defaultWorkspace: 'acme', apiUrl: 'https://api.example' },
    path,
  )
  const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
  const fetchImpl: FetchLike = async (input, init) => {
    expect(String(input)).toBe('https://api.example/v1/user/sync-machines')
    requests.push({
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    })
    return Response.json({
      machineId: 'machine_mac',
      name: 'MacBook',
      syncthingDeviceId: 'AAAAAAA-BBBBBBB',
      createdAt: 1,
      lastUsedAt: 1,
    })
  }
  const first = await createCommandContext([], { home, env: {}, fetch: fetchImpl })
  expect(await registerSyncMachine(first.ctx, binary)).toBe('machine_mac')
  const cert = await readFile(join(macIdentityHome(home), 'cert.pem'), 'utf8')
  await saveConfig({ ...(await loadConfig(path)), apiKey: 'key-two' }, path)
  const second = await createCommandContext([], { home, env: {}, fetch: fetchImpl })
  expect(await registerSyncMachine(second.ctx, binary)).toBe('machine_mac')
  expect(await readFile(join(macIdentityHome(home), 'cert.pem'), 'utf8')).toBe(cert)
  expect(await loadConfig(path)).toEqual({
    apiKey: 'key-two',
    machineId: 'machine_mac',
    defaultWorkspace: 'acme',
    apiUrl: 'https://api.example',
  })
  expect(requests.map(request => request.authorization)).toEqual([
    'Bearer key-one',
    'Bearer key-two',
  ])
  expect(requests[0]?.body.syncthingDeviceId).toBe('AAAAAAA-BBBBBBB')
  expect(requests[0]?.body.machineId).toBeUndefined()
  expect(requests[1]?.body.machineId).toBeUndefined()
})

test('explicit sync activation replaces a foreign cached machine ID after account and origin change', async () => {
  const { home, binary } = await scratch()
  const path = configPathForHome(home)
  await prepareMacIdentity(binary, macIdentityHome(home))
  const cert = await readFile(join(macIdentityHome(home), 'cert.pem'), 'utf8')
  await saveConfig(
    {
      apiKey: 'new-account-key',
      apiUrl: 'https://new-control.example',
      defaultWorkspace: 'studio',
      machineId: 'previous-account-machine',
    },
    path,
  )
  const { ctx } = await createCommandContext([], {
    home,
    env: {},
    fetch: async (input, init) => {
      expect(String(input)).toBe('https://new-control.example/v1/user/sync-machines')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-account-key')
      const body = JSON.parse(String(init?.body))
      if ('machineId' in body) return Response.json({ error: 'not_found' }, { status: 404 })
      expect(body.syncthingDeviceId).toBe('AAAAAAA-BBBBBBB')
      return Response.json({
        machineId: 'new-account-machine',
        name: body.name,
        syncthingDeviceId: body.syncthingDeviceId,
        createdAt: 1,
        lastUsedAt: 1,
      })
    },
  })
  expect(await registerSyncMachine(ctx, binary)).toBe('new-account-machine')
  expect(await loadConfig(path)).toEqual({
    apiKey: 'new-account-key',
    apiUrl: 'https://new-control.example',
    defaultWorkspace: 'studio',
    machineId: 'new-account-machine',
  })
  expect(await readFile(join(macIdentityHome(home), 'cert.pem'), 'utf8')).toBe(cert)
})

test('concurrent first starts publish one complete Mac certificate pair', async () => {
  const { home, binary } = await scratch()
  const identityHome = macIdentityHome(home)
  await Promise.all([
    prepareMacIdentity(binary, identityHome),
    prepareMacIdentity(binary, identityHome),
  ])
  const cert = await readFile(join(identityHome, 'cert.pem'), 'utf8')
  const key = await readFile(join(identityHome, 'key.pem'), 'utf8')
  expect(key).toBe(`${cert}-key`)
  await prepareMacIdentity(binary, identityHome)
  expect(await readFile(join(identityHome, 'cert.pem'), 'utf8')).toBe(cert)
})

test('machine removal lookup follows account pages and ignores another live Mac', async () => {
  const requests: string[] = []
  const api = {
    request: async (path: string) => {
      requests.push(path)
      const target = path.includes('cursor=older')
      return Response.json({
        items: [
          {
            machineId: target ? 'machine_mac' : 'machine_other',
            name: 'Mac',
            syncthingDeviceId: 'AAAAAAA-BBBBBBB',
            createdAt: 1,
            lastUsedAt: 1,
            ...(target ? { removedAt: 2 } : {}),
          },
        ],
        nextCursor: target ? null : 'older',
      })
    },
  }
  expect(await isSyncMachineActive(api, 'machine_mac')).toBe(false)
  expect(requests).toEqual([
    '/user/sync-machines?limit=100',
    '/user/sync-machines?limit=100&cursor=older',
  ])
})
