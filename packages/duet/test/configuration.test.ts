import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandContext } from '../src/cli-support.js'
import { configPathForHome, saveConfig } from '../src/config.js'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
test('REST commands use the explicit key and API origin over the saved login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-config-'))
  homes.push(home)
  await saveConfig({ apiKey: 'saved-key', apiUrl: 'https://saved.test' }, configPathForHome(home))
  const requests: Array<{ url: string; key: string | null }> = []
  const { ctx } = await createCommandContext([], {
    home,
    env: { DUET_API_KEY: 'explicit-key', DUET_API_URL: 'https://input.test/' },
    fetch: (async (url, init) => {
      requests.push({ url: String(url), key: new Headers(init?.headers).get('authorization') })
      return Response.json({ ok: true })
    }),
  })
  await ctx.api.request('/whoami')
  expect(requests).toEqual([{ url: 'https://input.test/v1/whoami', key: 'Bearer explicit-key' }])
})

test('the local model command uses the saved login and workspace on its actual requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-model-config-'))
  homes.push(home)
  await saveConfig({ apiKey: 'saved-key', defaultWorkspace: 'harbor' }, configPathForHome(home))
  const captured: Array<{ path: string; workspace: string | null; key: string | null }> = []
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      captured.push({
        path,
        workspace: request.headers.get('x-duet-workspace'),
        key: request.headers.get('authorization'),
      })
      if (path === '/v1/models')
        return Response.json({ data: [{ id: 'fixture/image', type: 'image' }] })
      if (path === '/v4/ai/config') return Response.json({ models: [] })
      return Response.json({ images: [png] })
    },
  })
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      DUET_GATEWAY_BASE_URL: server.url.origin,
    }
    delete env.DUET_API_KEY
    delete env.DUET_WORKSPACE
    delete env.AI_GATEWAY_API_KEY
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../src/cli-entry.ts', import.meta.url).pathname,
        'model',
        '-m',
        'fixture/image',
        '--type',
        'image',
        '--out',
        join(home, 'image.png'),
        'draw',
      ],
      { env, cwd: home, stdout: 'pipe', stderr: 'pipe' },
    )
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).not.toContain('Fatal:')
    expect(exitCode).toBe(0)
    expect(captured).toEqual(
      ['/v1/models', '/v4/ai/image-model'].map(path => ({
        path,
        workspace: 'harbor',
        key: 'Bearer saved-key',
      })),
    )
    expect(
      Buffer.from(await Bun.file(join(home, 'image.png')).arrayBuffer()).toString('base64'),
    ).toBe(png)
  } finally {
    server.stop(true)
  }
}, 15_000)

test('env import saves the Duet login in config and other provider keys in the env file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-import-config-'))
  homes.push(home)
  const source = join(home, 'source.env')
  const providerEnv = join(home, 'providers.env')
  await Bun.write(
    source,
    'DUET_API_KEY=imported-key\nOPENROUTER_API_KEY=provider-key\nAPP_SECRET=unrelated\n',
  )
  const { runEnvCommand } = await import('../src/cli/env.js')
  await runEnvCommand(['--env-file', providerEnv, '--import', source], { home })
  await expect(
    (await import('../src/config.js')).loadConfig(configPathForHome(home)),
  ).resolves.toEqual({ apiKey: 'imported-key' })
  expect(await Bun.file(providerEnv).text()).toBe('OPENROUTER_API_KEY=provider-key\n')
})

test('updating another provider preserves an explicit custom env credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-custom-provider-'))
  homes.push(home)
  const target = join(home, 'project.env')
  await Bun.write(target, 'DUET_API_KEY=explicit-project-key\nOPENROUTER_API_KEY=old-provider-key\n')
  const { runEnvCommand } = await import('../src/cli/env.js')
  await runEnvCommand(['--env-file', target, '--keys'], { home, interactive: true, promptForApiKeys: async () => new Map([['OPENROUTER_API_KEY', 'new-provider-key']]) })
  expect(await Bun.file(target).text()).toBe('DUET_API_KEY=explicit-project-key\nOPENROUTER_API_KEY=new-provider-key\n')
  expect(await Bun.file(configPathForHome(home)).exists()).toBe(false)
})
