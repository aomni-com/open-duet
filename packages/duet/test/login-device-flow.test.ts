import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandContext } from '../src/cli-support.js'
import { runLoginCommand } from '../src/cli/login.js'
import { configPathForHome, loadConfig, saveConfig } from '../src/config.js'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

test('login approves the person and replaces only the canonical saved credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-login-'))
  homes.push(home)
  await saveConfig({ defaultWorkspace: 'harbor', machineId: 'mac-one' }, configPathForHome(home))
  const requests: Array<{ url: string; body: unknown }> = []
  const responses = [
    {
      device_code: 'a'.repeat(64),
      user_code: 'ABCD-2345',
      verification_uri: 'https://app.test/device',
      expires_in: 900,
      interval: 1,
    },
    { status: 'pending', interval: 1 },
    {
      status: 'approved',
      access_token: 'duet_sk_person',
      prefix: 'duet_sk_person',
      token_type: 'bearer',
    },
  ]
  const fetchFn = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json(responses.shift())
  }) as typeof fetch
  const output: string[] = []
  const { ctx } = await createCommandContext([], {
    home,
    env: { DUET_API_URL: 'https://input.test' },
    fetch: fetchFn,
    sleep: async () => {},
    io: {
      stdout: { write: text => (output.push(String(text)), true) },
      stderr: { write: () => true },
    },
  })
  await runLoginCommand(['--no-browser'], ctx)
  expect(requests[0]).toEqual({
    url: 'https://input.test/v1/device/code',
    body: { client_name: 'Duet CLI' },
  })
  expect(await loadConfig(configPathForHome(home))).toEqual({
    apiKey: 'duet_sk_person',
    apiUrl: 'https://input.test',
    defaultWorkspace: 'harbor',
    machineId: 'mac-one',
  })
  expect(output.join('')).not.toContain('duet_sk_person')
  await expect(readFile(join(home, '.duet', '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a denied login preserves the saved key and a later approval can replace it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-login-retry-'))
  homes.push(home)
  await saveConfig({ apiKey: 'duet_sk_previous', machineId: 'mac-one' }, configPathForHome(home))
  let approved = false
  const { ctx } = await createCommandContext(['--json'], {
    home, env: { DUET_API_URL: 'https://input.test' },
    fetch: async url => String(url).endsWith('/code')
      ? Response.json({ device_code: 'a'.repeat(64), user_code: 'ABCD-2345', verification_uri: 'https://app.test/device', expires_in: 900, interval: 1 })
      : Response.json(approved ? { status: 'approved', access_token: 'duet_sk_next', token_type: 'bearer', prefix: 'duet_sk_next' } : { status: 'denied' }),
    io: { stdout: { write: () => true }, stderr: { write: () => true } },
  })
  await expect(runLoginCommand([], ctx)).rejects.toThrow('Device login denied.')
  expect(await loadConfig(configPathForHome(home))).toEqual({ apiKey: 'duet_sk_previous', machineId: 'mac-one' })
  approved = true
  await saveConfig({ apiKey: 'duet_sk_previous', machineId: 'mac-two', defaultWorkspace: 'orchard' }, configPathForHome(home))
  await runLoginCommand([], ctx)
  expect(await loadConfig(configPathForHome(home))).toEqual({ apiKey: 'duet_sk_next', apiUrl: 'https://input.test', machineId: 'mac-two', defaultWorkspace: 'orchard' })
})
