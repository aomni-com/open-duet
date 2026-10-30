import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { transportModelId } from '@repo/agent/model-resolution/catalog'
import { BUILT_IN_ROUTING_TABLE } from '@repo/agent/model-routing/table'
import { PROVIDER_MODEL_ALIASES } from '@repo/contract'

import { testIfDocker } from '../../agent/test/helpers/docker-only'
import { parseArgs, requestTypeForCapability, runModelCommand } from '../src/cli/model.js'

// Bad flags route through `fail()`, which calls process.exit(1). Patch it to
// throw so the pure parser tests can assert on the error path without exiting.
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`)
  }
}

describe('parseArgs', () => {
  let exitSpy: ReturnType<typeof spyOn> | undefined
  let errorSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code)
    })
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    exitSpy?.mockRestore()
    errorSpy?.mockRestore()
  })

  test('parses a family model, type, image and numeric flags', () => {
    const parsed = parseArgs([
      '-m',
      'sol',
      '--type',
      'image',
      '--image',
      'src.png',
      '-o',
      'art.png',
      '--system',
      'be terse',
      '--size',
      '1024x1024',
      '--n',
      '3',
      '--seed',
      '7',
      '--duration',
      '5',
      '--fps',
      '24',
      'a fox',
      'in snow',
    ])
    expect(parsed.model).toBe('sol')
    expect(parsed.type).toBe('image')
    expect(parsed.imagePath).toBe('src.png')
    expect(parsed.out).toBe('art.png')
    expect(parsed.system).toBe('be terse')
    expect(parsed.size).toBe('1024x1024')
    expect(parsed.n).toBe(3)
    expect(parsed.seed).toBe(7)
    expect(parsed.duration).toBe(5)
    expect(parsed.fps).toBe(24)
    expect(parsed.prompt).toBe('a fox in snow')
    expect(parsed.help).toBe(false)
  })

  test('--background is an OpenAI image switch with three modes', () => {
    expect(parseArgs(['--background', 'transparent']).background).toBe('transparent')
    expect(parseArgs(['--background', 'opaque']).background).toBe('opaque')
    expect(parseArgs(['--background', 'auto']).background).toBe('auto')
    expect(parseArgs([]).background).toBeUndefined()
  })

  test('rejects an invalid --background', () => {
    expect(() => parseArgs(['--background', 'clear'])).toThrow(ExitCalled)
  })

  test('--help sets the help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  test('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(ExitCalled)
  })

  test('rejects an invalid --type', () => {
    expect(() => parseArgs(['--type', 'audio'])).toThrow(ExitCalled)
  })

  test('rejects a flag missing its value', () => {
    expect(() => parseArgs(['--model'])).toThrow(ExitCalled)
  })

  test('rejects a value option followed by another flag', () => {
    expect(() => parseArgs(['-m', '--type', 'image'])).toThrow(ExitCalled)
  })
})

describe('requestTypeForCapability', () => {
  test('image and video map straight through', () => {
    expect(requestTypeForCapability('image')).toBe('image')
    expect(requestTypeForCapability('video')).toBe('video')
  })

  test('language and other capabilities default to text', () => {
    expect(requestTypeForCapability('language')).toBe('text')
    expect(requestTypeForCapability('embedding')).toBe('text')
    expect(requestTypeForCapability(undefined)).toBe('text')
  })
})

describe('model resolution debug output', () => {
  test.each([
    ['sol', 'gpt-6.1-sol'],
    ['astra', 'gpt-6-astra'],
  ])(
    'prints the ChatGPT transport spec for %s without making a request',
    async (shorthand, modelId) => {
      const writes: string[] = []
      const writeSpy = spyOn(process.stdout, 'write').mockImplementation(chunk => {
        writes.push(String(chunk))
        return true
      })

      try {
        await runModelCommand(['--resolve', shorthand, '--transport', 'openai-codex'])
      } finally {
        writeSpy.mockRestore()
      }

      // What this command owes the reader is the routing decision — which
      // transport and which endpoint a name resolves to — plus whatever the
      // catalog says the model costs, printed verbatim rather than reshaped.
      // The vendor owns those numbers, so only their presence is asserted.
      const printed = JSON.parse(writes.join('')) as {
        model: string
        api: string
        baseUrl: string
        cost: { input: number; output: number }
      }
      expect(printed).toMatchObject({
        model: `openai-codex:${modelId}`,
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
      })
      expect(printed.cost.input).toBeGreaterThan(0)
      expect(printed.cost.output).toBeGreaterThan(0)
    },
  )
})

const cliEntry = join(import.meta.dir, '../dist/cli-entry.js')

// The public executable gets a disposable home and controlled network boundary.
async function probeModel(
  args: string[],
  options: {
    workspace?: string
    invalidRouting?: boolean
    credential?: string
    failGeneration?: boolean
    vision?: boolean
    defaultLookupFailure?: boolean
    stdin?: string
    readOutput?: string
    outputBefore?: string
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'model-default-'))
  const records: Array<{
    path: string
    model: string | null
    workspace: string | null
    tier: string | null
    body?: unknown
  }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const record = {
        path,
        model: request.headers.get('ai-language-model-id') ?? request.headers.get('ai-model-id'),
        workspace: request.headers.get('x-duet-workspace'),
        tier: request.headers.get('x-duet-tier'),
        ...(request.method === 'POST' ? { body: await request.json() } : {}),
      }
      records.push(record)
      if (path === '/v1/whoami' && options.defaultLookupFailure)
        return Response.json({ error: 'unavailable' }, { status: 503 })
      if (path === '/v1/whoami')
        return Response.json({
          user: { id: 'owner', email: 'owner@example.test' },
          workspaces: [
            {
              id: 'workspace_1',
              slug: 'fixture',
              name: 'Fixture',
              status: 'active',
              servicingStatus: 'active',
              role: 'owner',
              billingUserId: 'owner',
              funding: { plan: null, active: true },
              creditRecovery: null,
              defaultTier: {
                configured: 'frontier',
                effective: 'balanced',
              },
            },
          ],
          scopes: [],
          versions: { api: 1 },
          internalAdmin: false,
          credential: { kind: options.credential ?? 'user' },
        })
      if (path === '/v1/models') return Response.json({ data: [] })
      if (options.failGeneration)
        return Response.json(
          { error: { message: 'controlled failure', type: 'internal_server_error' } },
          { status: 500 },
        )
      return new Response(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: 'controlled text' },
          { type: 'text-end', id: 'text' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ]
          .map(event => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  try {
    await mkdir(join(home, '.duet'))
    const table = structuredClone(BUILT_IN_ROUTING_TABLE)
    table.tiers.balanced!.routes.general!.target.modelName = 'astra'
    table.tiers.frontier!.routes.general!.target.modelName = 'sol'
    if (options.vision) {
      table.tiers.balanced!.routes.general!.target.modelName = 'frontier'
      table.tiers.frontier!.routes.general!.target.modelName = 'glm-5.3'
      table.tiers.frontier!.routes.general!.visionFallbackModelName = 'astra'
      await writeFile(join(home, 'source.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    }
    await writeFile(
      join(home, '.duet/models.json'),
      options.invalidRouting ? '{broken' : JSON.stringify(table),
    )
    if (options.readOutput && options.outputBefore !== undefined)
      await writeFile(join(home, options.readOutput), options.outputBefore)
    const proc = Bun.spawn(['bun', cliEntry, 'model', ...args], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        DUET_API_KEY: 'fixture',
        DUET_API_URL: server.url.toString(),
        DUET_GATEWAY_BASE_URL: server.url.toString(),
        DUET_WORKSPACE: options.workspace ?? '',
        AI_GATEWAY_API_KEY: '',
        OPENROUTER_API_KEY: '',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (options.stdin) proc.stdin.write(options.stdin)
    proc.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output =
      options.readOutput && (code === 0 || options.outputBefore !== undefined)
        ? await readFile(join(home, options.readOutput), 'utf8')
        : undefined
    return { stdout, stderr, code, records, output }
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

testIfDocker(
  'omitted text uses the selected effective workspace default at upstream cost',
  async () => {
    const result = await probeModel(['hello'], { workspace: 'fixture' })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('controlled text\n')
    expect(result.records).toEqual([
      expect.objectContaining({ path: '/v1/whoami' }),
      expect.objectContaining({
        path: '/v4/ai/language-model',
        model: transportModelId('duet-gateway', 'astra'),
        workspace: 'fixture',
        tier: null,
      }),
    ])
  },
  30_000,
)

testIfDocker(
  'max-retries zero makes a failed text request only once',
  async () => {
    const result = await probeModel(
      ['-m', 'vendor/new-text', '--type', 'text', '--max-retries', '0', 'hello'],
      { failGeneration: true },
    )
    expect(result.code).not.toBe(0)
    expect(result.records).toEqual([
      expect.objectContaining({ path: '/v4/ai/language-model', model: 'vendor/new-text' }),
    ])
  },
  30_000,
)

testIfDocker.each(['openai/gpt-6.1-sol', 'vendor/new-text'])(
  'raw %s survives invalid routing without default discovery',
  async model => {
    const result = await probeModel(['-m', model, '--type', 'text', 'hello'], {
      invalidRouting: true,
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('controlled text\n')
    expect(result.records).toEqual([
      expect.objectContaining({ path: '/v4/ai/language-model', model, tier: null }),
    ])
  },
  30_000,
)

testIfDocker(
  'compound general routes recurse and preserve vision fallback without classification',
  async () => {
    const result = await probeModel(
      ['-m', 'balanced', '--type', 'text', '--image', 'source.png', 'hello'],
      { vision: true, workspace: 'fixture' },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('controlled text\n')
    expect(result.records).toEqual([
      expect.objectContaining({
        path: '/v4/ai/language-model',
        model: transportModelId('duet-gateway', 'astra'),
        workspace: 'fixture',
        tier: null,
        body: expect.objectContaining({
          prompt: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'file', mediaType: 'image/png' }),
              ]),
            }),
          ]),
        }),
      }),
    ])
  },
  30_000,
)

testIfDocker(
  'provider aliases use their existing backing family without discovery or tier attribution',
  async () => {
    const result = await probeModel(['-m', 'openai-max', '--type', 'text', 'hello'], {
      workspace: 'fixture',
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('controlled text\n')
    expect(result.records).toEqual([
      expect.objectContaining({
        path: '/v4/ai/language-model',
        model: PROVIDER_MODEL_ALIASES['openai-max'].gatewayModelId,
        workspace: 'fixture',
        tier: null,
      }),
    ])
  },
  30_000,
)

testIfDocker.each([
  ['unselected human', {}],
  ['unselected impersonation', { credential: 'impersonation' }],
  ['inaccessible selected workspace', { workspace: 'other' }],
  ['unavailable workspace summary', { workspace: 'fixture', defaultLookupFailure: true }],
])(
  '%s fails before generation and never chooses another workspace',
  async (_label, options) => {
    const result = await probeModel(['hello'], options)
    expect(result.code).not.toBe(0)
    expect(result.records).toEqual([expect.objectContaining({ path: '/v1/whoami' })])
  },
  30_000,
)

testIfDocker.each(['app', 'system_vm', 'oauth'])(
  'a single-workspace %s credential uses its effective default without a selector',
  async credential => {
    const result = await probeModel(['hello'], { credential })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('controlled text\n')
    expect(result.records).toEqual([
      expect.objectContaining({ path: '/v1/whoami' }),
      expect.objectContaining({
        path: '/v4/ai/language-model',
        model: transportModelId('duet-gateway', 'astra'),
        workspace: null,
        tier: null,
      }),
    ])
  },
  30_000,
)

testIfDocker(
  'explicit direct-Vercel calls need no Duet login or default lookup',
  async () => {
    const previous = {
      DUET_API_KEY: process.env.DUET_API_KEY,
      AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
      DUET_WORKSPACE: process.env.DUET_WORKSPACE,
    }
    const requests: Array<{
      url: string
      model: string | null
      authorization: string | null
      tier: string | null
      workspace: string | null
    }> = []
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const headers = new Headers(init?.headers)
          requests.push({
            url: String(input),
            model: headers.get('ai-language-model-id'),
            authorization: headers.get('authorization'),
            tier: headers.get('x-duet-tier'),
            workspace: headers.get('x-duet-workspace'),
          })
          return new Response(
            [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: 'direct text' },
              { type: 'text-end', id: 'text' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
              },
            ]
              .map(event => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
        { preconnect: fetch.preconnect },
      ),
    )
    const writes: string[] = []
    const outputSpy = spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk))
      return true
    })
    try {
      delete process.env.DUET_API_KEY
      process.env.AI_GATEWAY_API_KEY = 'vercel-fixture'
      process.env.DUET_WORKSPACE = 'unrelated'
      await runModelCommand(['-m', 'vendor/unknown-direct', '--type', 'text', 'hello'])
      expect(requests).toEqual([
        {
          url: 'https://ai-gateway.vercel.sh/v4/ai/language-model',
          model: 'vendor/unknown-direct',
          authorization: 'Bearer vercel-fixture',
          tier: null,
          workspace: null,
        },
      ])
      expect(writes.join('')).toBe('direct text\n')
    } finally {
      fetchSpy.mockRestore()
      outputSpy.mockRestore()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
  30_000,
)

testIfDocker(
  'stdin, system prompt and text output bytes keep their direct-call contract',
  async () => {
    const result = await probeModel(
      ['-m', 'vendor/text', '--type', 'text', '--system', 'be brief', '--out', 'completion.txt'],
      { stdin: 'input from pipe', readOutput: 'completion.txt' },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('controlled text')
    expect(result.output).toBe('controlled text')
    expect(result.records).toEqual([
      expect.objectContaining({
        path: '/v4/ai/language-model',
        model: 'vendor/text',
        body: expect.objectContaining({
          prompt: [
            { role: 'system', content: 'be brief' },
            { role: 'user', content: [{ type: 'text', text: 'input from pipe' }] },
          ],
        }),
      }),
    ])
  },
  30_000,
)

testIfDocker.each(['image', 'video'])(
  'max-retries zero makes a failed %s generation only once',
  async kind => {
    const result = await probeModel(
      ['-m', 'vendor/new-media', '--type', kind, '--max-retries', '0', 'hello'],
      { failGeneration: true },
    )
    expect(result.code).not.toBe(0)
    const requests = result.records.filter(item => item.path !== '/v1/models')
    expect(requests).toEqual([
      expect.objectContaining({ path: `/v4/ai/${kind}-model`, model: 'vendor/new-media' }),
    ])
  },
  30_000,
)

testIfDocker(
  'failed text generation leaves an existing output file intact',
  async () => {
    const result = await probeModel(
      [
        '-m',
        'vendor/new-text',
        '--type',
        'text',
        '--max-retries',
        '0',
        '--out',
        'completion.txt',
        'hello',
      ],
      { failGeneration: true, readOutput: 'completion.txt', outputBefore: 'previous output' },
    )
    expect(result.code).not.toBe(0)
    expect(result.output).toBe('previous output')
    expect(result.stdout).toBe('')
  },
  30_000,
)
