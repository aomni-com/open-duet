import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PUBLIC_API_ENDPOINTS } from '@repo/contract'

import {
  dockerCliEnv,
  dockerTestsOptedIn as harnessDockerTestsOptedIn,
} from '../../test-harness/src/docker-cli-env'
import packageJson from '../package.json'
import { runCli } from '../src/cli.js'
import { configPathForHome, loadConfig, saveConfig } from '../src/config.js'
import { EXIT_CODES } from '../src/exit-codes.js'

const SECRET_KEY = 'duet_sk_mock_secret_never_print'
const PLANTED_IMPORT_KEY = 'sk-proj-' + 'B'.repeat(48)
const tempDirs: string[] = []
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = process.env.DUET_TEST_ENTRY ?? join(packageRoot, 'dist/cli-entry.js')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('duet CLI', () => {
  test('--version prints the package version and exits successfully', async () => {
    const run = await capture(['--version'], { home: await tempHome() })

    expect(run).toMatchObject({ exitCode: 0, stdout: `${packageJson.version}\n`, stderr: '' })
  })

  test('help omits the removed ai command', async () => {
    const home = await tempHome()
    const help = await capture(['--help'], { home })
    expect(help.exitCode).toBe(EXIT_CODES.ok)
    expect(help.stdout).not.toContain('duet ai')
  })

  test('login stores the approved device key without printing it', async () => {
    await withMockApi(async api => {
      const home = await tempHome()
      const run = await capture(
        ['--api-url', api.baseUrl, '--json', 'login', '--workspace', 'demo'],
        { home },
      )

      expect(run.exitCode).toBe(0)
      expect(run.stdout).toContain('"status":"pending_user"')
      expect(run.stdout).toContain('"status":"approved"')
      expect(run.stdout).not.toContain(SECRET_KEY)
      expect(run.stderr).not.toContain(SECRET_KEY)
      expect(api.state.deviceCodeBodies).toEqual([{ client_name: 'Duet CLI' }])
    })
  })

  test('login stops polling once the device code expires', async () => {
    await withMockApi(async api => {
      api.state.deviceTokenStatus = 'pending'
      api.state.deviceExpiresIn = 1
      const home = await tempHome()
      let now = 0
      const run = await capture(['--api-url', api.baseUrl, '--json', 'login'], {
        home,
        now: () => now,
        sleep: async ms => {
          now += ms
        },
      })

      expect(run.exitCode).toBe(EXIT_CODES.generic)
      expect(JSON.parse(run.stderr)).toMatchObject({ error: 'device_expired' })
    })
  })

  test('whoami, ls, and push have stable json output and authenticate with the stored key', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      await writeFile(join(home, 'hello.txt'), 'hello from duet!!\n')

      const whoami = await capture(['--json', 'whoami'], { home })
      expect(whoami.exitCode).toBe(0)
      expect(JSON.parse(whoami.stdout)).toEqual(mockWhoami())

      const push = await capture(['--json', 'push', join(home, 'hello.txt'), 'demo:/hello.txt'], {
        home,
      })
      expect(push.exitCode).toBe(0)
      expect(JSON.parse(push.stdout)).toEqual({
        ok: true,
        workspace: 'demo',
        path: '/hello.txt',
        bytes: 18,
        result: { ok: true, etag: '"mock-etag"', size: 18 },
      })

      const ls = await capture(['--json', 'ls', 'demo:/'], { home })
      expect(ls.exitCode).toBe(0)
      expect(JSON.parse(ls.stdout)).toEqual({
        items: [
          {
            name: 'hello.txt',
            path: 'hello.txt',
            type: 'file',
            size: 18,
            mtime: '2026-07-06T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      })
      const continued = await capture(['ls', 'demo:/', '--cursor', 'opaque-next', '--limit', '2'], {
        home,
      })
      expect(continued.exitCode).toBe(0)
      expect(continued.stdout).toBe('hello.txt\n')
      expect(api.state.fileListQueries).toContain(
        '/v1/ws/demo/files?list=1&cursor=opaque-next&limit=2',
      )
      expect(api.state.seenAuthorization.every(value => value === `Bearer ${SECRET_KEY}`)).toBe(
        true,
      )
    })
  })

  test('workspace list and status use the real whoami workspace projection', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)

      const list = await capture(['workspace', 'ls'], { home })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toBe('demo\n')

      const status = await capture(['--json', 'workspace', 'status'], { home })
      expect(status.exitCode).toBe(0)
      expect(JSON.parse(status.stdout)).toEqual({ workspace: mockWhoami().workspaces[0] })
      expect(api.state.requestPaths).toEqual(['/v1/whoami', '/v1/whoami'])
    })
  })

  test('push then cat round-trips bytes through the files API', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const bytes = new Uint8Array([0, 1, 2, 250, 255, 10])
      await Bun.write(join(home, 'bytes.bin'), bytes)

      expect(
        (await capture(['push', join(home, 'bytes.bin'), '/bytes.bin'], { home })).exitCode,
      ).toBe(0)
      const cat = await captureBytes(['cat', '/bytes.bin'], { home })
      expect(cat.exitCode).toBe(0)
      expect(cat.stdoutBytes).toEqual(Buffer.from(bytes))
    })
  })

  test('file commands preserve literal percent identities through the REST URL', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      await writeFile(join(home, 'percent.txt'), 'literal percent')
      await writeFile(join(home, 'encoded-looking.txt'), 'encoded-looking')

      expect(
        (await capture(['push', join(home, 'percent.txt'), 'demo:/100%.txt'], { home })).exitCode,
      ).toBe(0)
      expect(
        (await capture(['push', join(home, 'encoded-looking.txt'), 'demo:/a%2Fb.txt'], { home }))
          .exitCode,
      ).toBe(0)

      expect(api.state.files.get('/100%.txt')).toEqual(new TextEncoder().encode('literal percent'))
      expect(api.state.files.get('/a%2Fb.txt')).toEqual(new TextEncoder().encode('encoded-looking'))
      expect((await capture(['cat', 'demo:/100%.txt'], { home })).stdout).toBe('literal percent')
      expect((await capture(['cat', 'demo:/a%2Fb.txt'], { home })).stdout).toBe('encoded-looking')
    })
  })

  test('mkdir uses the explicit filesystem action instead of a placeholder file upload', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const created = await capture(['--json', 'mkdir', 'demo:/projects'], { home })

      expect(created.exitCode).toBe(0)
      expect(JSON.parse(created.stdout)).toMatchObject({
        ok: true,
        workspace: 'demo',
        path: '/projects',
        result: { ok: true, affectedEntries: 1 },
      })
      expect(api.state.fileActionBodies).toEqual([
        { operation: 'mkdir', path: 'projects', recursive: false },
      ])
      expect(api.state.files).toEqual(new Map())
    })
  })

  test('history queries the file-activity API and renders human and json output from the same page', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)

      const human = await capture(
        ['history', 'demo:/notes/plan.md', '--limit', '2', '--reads', '0', '--cursor', 'opaque-0'],
        { home },
      )
      expect(human.exitCode).toBe(0)
      expect(human.stdout).toBe(
        [
          '1\tcreate\tnotes/plan.md\tweb:user1\t1970-01-01T00:00:01.000Z',
          '5\trestore\t(workspace)\tsystem\t1970-01-01T00:00:05.000Z',
          '6\trename\tnotes/draft.md -> notes/plan.md\tterminal\t1970-01-01T00:00:06.000Z',
          'next: opaque-6',
          '',
        ].join('\n'),
      )

      const json = await capture(['--json', 'history', 'demo:/notes/plan.md'], { home })
      expect(json.exitCode).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual(mockFileHistoryPage())

      expect(api.state.fileActivityQueries).toEqual([
        '/v1/ws/demo/file-activity?path=notes%2Fplan.md&cursor=opaque-0&limit=2&reads=0',
        '/v1/ws/demo/file-activity?path=notes%2Fplan.md',
      ])
      expect((await capture(['history', 'demo:/x', '--reads', '2'], { home })).exitCode).toBe(
        EXIT_CODES.usage,
      )
    })
  })

  test('seen-by queries the file-activity API and renders one row per actor', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)

      const human = await capture(['seen-by', 'demo:/notes/plan.md'], { home })
      expect(human.exitCode).toBe(0)
      expect(human.stdout).toBe(
        [
          'web:user1\treads=4\twrites=1\tlast=1970-01-01T00:00:07.000Z',
          'session:ses1\treads=0\twrites=1\tlast=1970-01-01T00:00:02.000Z',
          '',
        ].join('\n'),
      )

      const json = await capture(['--json', 'seen-by', 'demo:/notes/plan.md'], { home })
      expect(json.exitCode).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual(mockSeenBy())

      expect(api.state.fileActivityQueries).toEqual([
        '/v1/ws/demo/file-activity/seen-by?path=notes%2Fplan.md',
        '/v1/ws/demo/file-activity/seen-by?path=notes%2Fplan.md',
      ])
    })
  })

  test('memory commands hit the memory API and do not shell an agent', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const add = await capture(
        [
          '--json',
          '--workspace',
          'demo',
          'memory',
          'add',
          'Enterprise cap is 20%',
          '--source',
          'api',
        ],
        { home },
      )
      expect(add.exitCode).toBe(0)
      expect(JSON.parse(add.stdout)).toMatchObject({ id: 'mem_1', source: 'api' })

      const search = await capture(
        ['--json', '--workspace', 'demo', 'memory', 'recall', 'cap', '--limit', '2'],
        { home },
      )
      expect(search.exitCode).toBe(0)
      expect(JSON.parse(search.stdout)).toMatchObject({
        query: 'cap',
        limit: 2,
        results: [{ id: 'mem_1' }],
      })
      expect(api.state.memoryBodies).toEqual([{ content: 'Enterprise cap is 20%', source: 'api' }])
    })
  })

  test('import with no source reads nothing and exits as an explicit no-op', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const imported = await capture(['--json', 'import', '--dry-run'], { home })

      expect(imported.exitCode).toBe(0)
      expect(JSON.parse(imported.stdout)).toEqual({
        dryRun: true,
        requestedSources: [],
        totalSnippets: 0,
        totalScrubbed: 0,
        totalWritten: 0,
        sources: [],
      })
      expect(imported.stderr).toBe('')
      expect(api.state.memoryBodies).toEqual([])
    })
  })

  test('import scrubs planted API keys before memory writes', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      await writeClaudeFixture(home, [
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `Customer contract note. API key ${PLANTED_IMPORT_KEY}`,
          },
        }),
      ])

      const imported = await capture(['--json', 'import', 'claude-code'], { home })

      expect(imported.exitCode).toBe(0)
      expect(JSON.parse(imported.stdout)).toMatchObject({
        dryRun: false,
        requestedSources: ['claude-code'],
        totalSnippets: 1,
        totalScrubbed: 1,
        totalWritten: 1,
      })
      expect(api.state.memoryBodies).toHaveLength(1)
      expect(api.state.memoryBodies[0]).toEqual({
        content: 'Customer contract note. API key [REDACTED]',
        source: 'import',
      })
      expect(JSON.stringify(api.state.memoryBodies)).not.toContain(PLANTED_IMPORT_KEY)
    })
  })

  test('import dry-run reports scrubbed refs and writes nothing', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      await writeClaudeFixture(home, [
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: `Token ${PLANTED_IMPORT_KEY}` },
        }),
      ])

      const imported = await capture(['--json', 'import', 'claude-code', '--dry-run'], { home })

      expect(imported.exitCode).toBe(0)
      const report = JSON.parse(imported.stdout)
      expect(report).toMatchObject({
        dryRun: true,
        totalSnippets: 1,
        totalScrubbed: 1,
        totalWritten: 0,
      })
      expect(report.sources[0].scrubbedSourceRefs).toHaveLength(1)
      expect(imported.stdout).not.toContain(PLANTED_IMPORT_KEY)
      expect(api.state.memoryBodies).toEqual([])
    })
  })

  test('import quarantines malformed transcripts loudly and continues importing valid snippets', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      await writeClaudeFixture(home, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'valid claude note' } }),
        '{bad json',
        JSON.stringify({ type: 'metadata', message: { content: 'not dialogue' } }),
        JSON.stringify({ event: 'unexpected', message: { content: 'unknown shape' } }),
      ])
      const codexDir = join(home, '.codex', 'sessions', '2026', '07', '06')
      await mkdir(codexDir, { recursive: true })
      await writeFile(
        join(codexDir, 'session.jsonl'),
        JSON.stringify({
          type: 'response_item',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'valid codex note' }],
          },
        }),
      )

      const imported = await capture(['--json', 'import', 'claude-code', 'codex'], { home })

      expect(imported.exitCode).toBe(0)
      expect(imported.stderr).toContain('warning: claude-code: quarantined malformed JSONL record')
      expect(imported.stderr).toContain(
        'warning: claude-code: quarantined unknown transcript shape',
      )
      expect(api.state.memoryBodies.map(body => body.content)).toEqual([
        'valid claude note',
        'valid codex note',
      ])
    })
  })

  test('train streams binary files directly to the VM before starting a bodyless job', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const localFile = join(home, 'profile.bin')
      const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255, 10])
      await writeFile(localFile, bytes)
      const train = await capture(['--json', 'train', '--workspace', 'demo', '--file', localFile], {
        home,
      })
      expect(train.exitCode).toBe(0)
      expect(JSON.parse(train.stdout)).toEqual({
        job: { jobId: 'train_1', workspaceId: 'ws_1', state: 'done', phase: 'done' },
      })
      expect(api.state.trainSessionRequests).toBe(1)
      expect(api.state.trainUploads).toEqual([
        {
          filename: 'profile.bin',
          authorization: 'Bearer mock_upload_token',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ])
      expect(api.state.trainBodies).toEqual([null])
      expect(api.state.trainPolls).toBe(2)
    })
  })

  test('train command exits non-zero when the async job fails', async () => {
    await withMockApi(async api => {
      api.state.trainFailure = true
      const home = await configuredHome(api.baseUrl)
      const train = await capture(
        ['--json', 'train', '--workspace', 'demo', '--url', 'https://acme.example'],
        {
          home,
        },
      )
      expect(train.exitCode).toBe(EXIT_CODES.generic)
      expect(JSON.parse(train.stderr)).toMatchObject({
        error: 'train_failed',
        message: 'mock train failed',
      })
    })
  })

  test('train command exits non-zero when polling never reaches a terminal state', async () => {
    await withMockApi(async api => {
      api.state.trainStuck = true
      const home = await configuredHome(api.baseUrl)
      let now = 0
      const train = await capture(
        [
          '--json',
          'train',
          '--workspace',
          'demo',
          '--url',
          'https://acme.example',
          '--wait-timeout',
          '2',
        ],
        {
          home,
          now: () => now,
          sleep: async ms => {
            now += ms
          },
        },
      )

      expect(train.exitCode).toBe(EXIT_CODES.generic)
      expect(JSON.parse(train.stderr)).toMatchObject({ error: 'train_timeout' })
    })
  })

  test('workspace use does not persist a transient api-url override', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const used = await capture(
        ['--api-url', 'https://override.example', '--json', 'workspace', 'use', 'other'],
        { home },
      )

      expect(used.exitCode).toBe(0)
      expect(await loadConfig(configPathForHome(home))).toMatchObject({
        apiUrl: api.baseUrl,
        defaultWorkspace: 'other',
      })
    })
  })

  test('agent commands call the agent REST API and stream turn events', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const humanRun = await capture(['agent', 'run', 'summarize reports'], { home })
      expect(humanRun.exitCode).toBe(0)
      expect(humanRun.stdout).toContain('Hello live stream\n')
      expect(humanRun.stdout).not.toContain('text: Hello live stream')
      expect(humanRun.stdout).toContain('tool: read_file call-1 running\n')
      expect(humanRun.stdout).toContain('tool: read_file call-1 ok\n')
      expect(humanRun.stdout.indexOf('tool: read_file call-1 running\n')).toBeLessThan(
        humanRun.stdout.indexOf('tool: read_file call-1 ok\n'),
      )
      expect(humanRun.stdout).toContain('complete: done\n')
      expect(humanRun.stdout).not.toContain('after terminal')

      const run = await capture(['--json', 'agent', 'run', 'summarize reports'], { home })
      expect(run.exitCode).toBe(0)
      expect(
        run.stdout
          .trim()
          .split('\n')
          .map(line => JSON.parse(line)),
      ).toEqual([
        { session: { sessionId: 'sess_1', status: 'running', lastEventSeq: 1 } },
        {
          seq: 2,
          event: {
            type: 'turn_started',
            state: {
              status: 'running',
              mode: 'agent',
              agent: { status: 'running', messages: [] },
            },
          },
        },
        { event: { type: 'step', step: { type: 'text_delta', delta: 'Hello ' } } },
        { event: { type: 'step', step: { type: 'text_delta', delta: 'live ' } } },
        { event: { type: 'step', step: { type: 'text_delta', delta: 'stream' } } },
        {
          seq: 3,
          event: {
            type: 'step',
            step: { type: 'text', text: 'Hello live stream' },
          },
        },
        {
          event: {
            type: 'step',
            step: {
              type: 'tool_call_start',
              toolName: 'read_file',
              toolCallId: 'call-1',
              input: { path: 'README.md' },
            },
          },
        },
        {
          seq: 4,
          event: {
            type: 'step',
            step: {
              type: 'tool_call',
              toolName: 'read_file',
              toolCallId: 'call-1',
              input: { path: 'README.md' },
              isError: false,
              output: [{ type: 'text', text: 'ok' }],
            },
          },
        },
        {
          seq: 5,
          event: {
            type: 'complete',
            state: {
              status: 'completed',
              mode: 'agent',
              agent: { status: 'completed', messages: [] },
            },
            status: 'completed',
            result: 'done',
          },
        },
      ])
      expect(run.stdout).not.toContain('after terminal')

      const answer = await capture(['--json', 'agent', 'answer', 'sess_1', 'approved'], { home })
      expect(answer.exitCode).toBe(0)
      expect(JSON.parse(answer.stdout)).toEqual({ ok: true, answer: 'approved' })

      const interrupt = await capture(['--json', 'agent', 'interrupt', 'sess_1'], { home })
      expect(interrupt.exitCode).toBe(0)
      expect(JSON.parse(interrupt.stdout)).toEqual({ ok: true, interrupted: true })
      expect(api.state.agentPrompts).toEqual(['summarize reports', 'summarize reports'])
    })
  })

  test('billing usage prints the workspace usage report as json', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)
      const usage = await capture(
        ['--json', 'billing', 'usage', '--period', 'daily', '--group', 'app'],
        { home },
      )
      expect(usage.exitCode).toBe(0)
      expect(JSON.parse(usage.stdout)).toEqual({
        period: 'daily',
        group: 'app',
        rows: [
          { workspaceId: 'ws_1', period: '2026-07-06', appSlug: 'site', spendMicroUsd: 370_000 },
        ],
      })
      expect(api.state.seenAuthorization.at(-1)).toBe(`Bearer ${SECRET_KEY}`)
    })
  })

  test('maps usage, auth, scope, not found, and network failures to deterministic exit codes', async () => {
    await withMockApi(async api => {
      const home = await configuredHome(api.baseUrl)

      expect((await capture(['--json', 'workspace', 'unknown'], { home })).exitCode).toBe(
        EXIT_CODES.usage,
      )
      expect(
        (await capture(['--json', 'whoami'], { home, apiKey: 'duet_sk_wrong' })).exitCode,
      ).toBe(EXIT_CODES.auth)

      const scope = await capture(['--json', 'ls', 'demo:/forbidden'], { home })
      expect(scope.exitCode).toBe(EXIT_CODES.scope)
      expect(JSON.parse(scope.stderr)).toEqual({
        error: 'insufficient_scope',
        message: 'Missing required scope: ws:demo:files:read',
        scope: 'ws:demo:files:read',
      })

      expect((await capture(['--json', 'cat', 'demo:/missing.txt'], { home })).exitCode).toBe(
        EXIT_CODES.notFound,
      )
    })

    const home = await configuredHome('http://127.0.0.1:9')
    expect((await capture(['--json', 'whoami'], { home })).exitCode).toBe(EXIT_CODES.network)
  })

  test.skipIf(!dockerTestsOptedIn())(
    'fresh container installs packed duet and round-trips through an in-container mock API',
    async () => {
      const packDir = await tempHome()
      const tarball = join(packDir, 'duet.tgz')
      const publicPackage = join(packDir, 'public-package')
      execFileSync(process.execPath, ['scripts/build-public-package.ts', publicPackage], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
      execFileSync(process.execPath, ['pm', 'pack', '--filename', tarball], {
        cwd: publicPackage,
        encoding: 'utf8',
      })
      const script = [
        'set -euo pipefail',
        "cat > /tmp/mock-api.ts <<'API'",
        'const files = new Map<string, Uint8Array>()',
        `const key = "${SECRET_KEY}"`,
        'Bun.serve({',
        '  hostname: "127.0.0.1",',
        '  port: 34567,',
        '  async fetch(request) {',
        '    const url = new URL(request.url)',
        '    if (url.pathname === "/v1/device/code") return Response.json({ device_code: "a".repeat(64), user_code: "ABCD-2345", verification_uri: "http://127.0.0.1:34567/device", expires_in: 900, interval: 1 })',
        '    if (url.pathname === "/v1/device/token") return Response.json({ status: "approved", access_token: key, token_type: "bearer", prefix: key })',
        '    if (request.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: "unauthorized" }, { status: 401 })',
        '    if (url.pathname === "/v1/whoami") return Response.json({ user: { id: "user_1", email: "agent@example.com" }, workspaces: [{ id: "ws_1", slug: "demo", name: "Demo", role: "owner" }], scopes: ["ws:demo:files:read", "ws:demo:files:write", "ws:demo:memory"], versions: { api: 1 } })',
        '    if (url.pathname.startsWith("/v1/ws/demo/files")) {',
        '      const path = decodeURIComponent(url.pathname.slice("/v1/ws/demo/files".length) || "/")',
        '      if (request.method === "PUT") { const bytes = new Uint8Array(await request.arrayBuffer()); files.set(path, bytes); return Response.json({ ok: true, etag: "\\"mock-etag\\"", size: bytes.byteLength }) }',
        '      if (request.method === "GET") { const bytes = files.get(path); if (!bytes) return Response.json({ error: "not_found" }, { status: 404 }); return new Response(bytes) }',
        '    }',
        '    return Response.json({ error: "not_found" }, { status: 404 })',
        '  },',
        '})',
        'API',
        'bun /tmp/mock-api.ts >/tmp/mock-api.log 2>&1 &',
        'api_pid=$!',
        'trap "kill $api_pid" EXIT',
        'timeout 30 bash -lc \'until bun -e "const r = await fetch(\\"http://127.0.0.1:34567/v1/device/code\\", { method: \\"POST\\" }); if (!r.ok) process.exit(1)" >/dev/null 2>&1; do sleep 0.2; done\'',
        'mkdir -p /tmp/duet-pin',
        'cd /tmp/duet-pin',
        'printf "hello from container\\n" > hello.txt',
        'timeout 60 bun add -g --production /tmp/duet.tgz >/tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }',
        'export PATH="/root/.bun/bin:$PATH"',
        'export DUET_API_URL=http://127.0.0.1:34567',
        'duet --json login > login.ndjson',
        'duet --json push ./hello.txt demo:/hello.txt > push.json',
        'duet cat demo:/hello.txt > roundtrip.txt',
        'test "$(cat roundtrip.txt)" = "hello from container"',
        'test "$HOME" = "/root"',
        '! test -f /Users/david/.duet/config.json',
        'printf "SLICE07_DOCKER_ROUNDTRIP ok home=%s bytes=%s\\n" "$HOME" "$(wc -c < roundtrip.txt)"',
      ].join('\n')

      const stdout = dockerRunScript(script, 360_000, [`${tarball}:/tmp/duet.tgz:ro`])
      expect(stdout).toContain('SLICE07_DOCKER_ROUNDTRIP ok home=/root bytes=21')
      console.log(stdout.trim())
    },
    420_000,
  )

  test.skipIf(!harnessDockerTestsOptedIn())(
    'fresh container imports Claude Code sessions through the CLI and recalls them',
    async () => {
      const packDir = await tempHome()
      const tarball = join(packDir, 'duet.tgz')
      const publicPackage = join(packDir, 'public-package')
      execFileSync(process.execPath, ['scripts/build-public-package.ts', publicPackage], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
      execFileSync(process.execPath, ['pm', 'pack', '--filename', tarball], {
        cwd: publicPackage,
        encoding: 'utf8',
      })
      const script = [
        'set -euo pipefail',
        "cat > /tmp/mock-api.ts <<'API'",
        'const memories = []',
        `const key = "${SECRET_KEY}"`,
        'Bun.serve({',
        '  hostname: "127.0.0.1",',
        '  port: 34567,',
        '  async fetch(request) {',
        '    const url = new URL(request.url)',
        '    if (url.pathname === "/v1/device/code") return Response.json({ device_code: "a".repeat(64), user_code: "ABCD-2345", verification_uri: "http://127.0.0.1:34567/device", expires_in: 900, interval: 1 })',
        '    if (url.pathname === "/v1/device/token") return Response.json({ status: "approved", access_token: key, token_type: "bearer", prefix: key })',
        '    if (request.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: "unauthorized" }, { status: 401 })',
        '    if (url.pathname === "/v1/ws/demo/memories" && request.method === "POST") { const body = await request.json(); memories.push({ id: `mem_${memories.length + 1}`, content: body.content, source: body.source, kind: "note", priority: "medium", createdAt: "2026-07-06T00:00:00.000Z", lastUsedAt: "2026-07-06T00:00:00.000Z", observedDate: "2026-07-06", tags: [] }); return Response.json(memories.at(-1)) }',
        '    if (url.pathname === "/v1/ws/demo/memories/search") { const q = url.searchParams.get("q") || ""; const results = memories.filter(memory => memory.content.includes(q)).map(memory => ({ ...memory, relevanceScore: 1 })); return Response.json({ query: q, limit: Number(url.searchParams.get("limit") || "10"), results }) }',
        '    return Response.json({ error: "not_found" }, { status: 404 })',
        '  },',
        '})',
        'API',
        'bun /tmp/mock-api.ts >/tmp/mock-api.log 2>&1 &',
        'api_pid=$!',
        'trap "kill $api_pid" EXIT',
        'timeout 30 bash -lc \'until bun -e "const r = await fetch(\\"http://127.0.0.1:34567/v1/device/code\\", { method: \\"POST\\" }); if (!r.ok) process.exit(1)" >/dev/null 2>&1; do sleep 0.2; done\'',
        'timeout 60 bun add -g --production /tmp/duet.tgz >/tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }',
        'export PATH="/root/.bun/bin:$PATH"',
        'export DUET_API_URL=http://127.0.0.1:34567',
        'mkdir -p /root/.claude/projects/demo',
        'printf "%s\\n" \'{"type":"user","message":{"role":"user","content":"fresh container renewal memory"}}\' > /root/.claude/projects/demo/session.jsonl',
        'duet --json login >/tmp/login.ndjson',
        'duet workspace use demo >/tmp/workspace.txt',
        'dry="$(duet --json import claude-code --dry-run)"',
        'echo "$dry" | grep \'"dryRun":true\' >/dev/null',
        'echo "$dry" | grep \'"totalSnippets":1\' >/dev/null',
        'duet --json import claude-code >/tmp/import.json',
        'search="$(duet --json memory recall renewal --workspace demo)"',
        'echo "$search" | grep "fresh container renewal memory" >/dev/null',
        'printf "SLICE17_IMPORT_DOCKER ok dry=%s recalled=%s\\n" "$(echo "$dry" | bun -e \'const stdin = await Bun.stdin.text(); console.log(JSON.parse(stdin).totalSnippets)\' )" "$(echo "$search" | bun -e \'const stdin = await Bun.stdin.text(); console.log(JSON.parse(stdin).results.length)\' )"',
      ].join('\n')

      const stdout = dockerCliEnv().runScript({
        script,
        timeoutMs: 420_000,
        volumes: [`${tarball}:/tmp/duet.tgz:ro`],
      })
      expect(stdout).toContain('SLICE17_IMPORT_DOCKER ok dry=1 recalled=1')
      console.log(stdout.trim())
    },
    480_000,
  )
})

async function capture(
  argv: string[],
  options: {
    home: string
    apiKey?: string
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: Array<string | Buffer> = []
  const stderr: Array<string | Buffer> = []
  let originalConfig: Awaited<ReturnType<typeof loadConfig>> | null = null
  if (options.apiKey !== undefined) {
    const config = await loadConfig(configPathForHome(options.home))
    originalConfig = config
    await saveConfig({ ...config, apiKey: options.apiKey }, configPathForHome(options.home))
  }
  if (!options.now && !options.sleep) {
    try {
      const result = await executeCli(argv, options.home)
      return {
        exitCode: result.exitCode,
        stdout: result.stdoutBytes.toString('utf8'),
        stderr: result.stderr,
      }
    } finally {
      if (originalConfig !== null) await saveConfig(originalConfig, configPathForHome(options.home))
    }
  }
  const result = await runCli(argv, {
    home: options.home,
    env: {},
    io: {
      stdout: {
        write: chunk => (stdout.push(Buffer.isBuffer(chunk) ? chunk : String(chunk)), true),
      },
      stderr: {
        write: chunk => (stderr.push(Buffer.isBuffer(chunk) ? chunk : String(chunk)), true),
      },
    },
    sleep: options.sleep ?? (async () => undefined),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (originalConfig !== null) await saveConfig(originalConfig, configPathForHome(options.home))
  return {
    exitCode: result.exitCode,
    stdout: chunksToString(stdout),
    stderr: chunksToString(stderr),
  }
}

async function captureBytes(
  argv: string[],
  options: { home: string },
): Promise<{ exitCode: number; stdoutBytes: Buffer; stderr: string }> {
  return executeCli(argv, options.home)
}

async function executeCli(
  argv: string[],
  home: string,
): Promise<{ exitCode: number; stdoutBytes: Buffer; stderr: string }> {
  const child = Bun.spawn([process.execPath, cliEntry, ...argv], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdoutBytes: Buffer.from(stdout), stderr }
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}

async function configuredHome(apiUrl: string): Promise<string> {
  const home = await tempHome()
  await saveConfig(
    {
      apiKey: SECRET_KEY,
      defaultWorkspace: 'demo',
      apiUrl,
    },
    configPathForHome(home),
  )
  return home
}

async function writeClaudeFixture(home: string, lines: string[]): Promise<void> {
  const dir = join(home, '.claude', 'projects', 'demo')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), lines.join('\n'))
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-cli-'))
  tempDirs.push(dir)
  return dir
}

function chunksToString(chunks: Array<string | Buffer>): string {
  return chunks.map(chunk => (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)).join('')
}

async function withMockApi(run: (api: MockApi) => Promise<void>): Promise<void> {
  const state: MockState = {
    files: new Map(),
    fileActionBodies: [],
    fileActivityQueries: [],
    apiRequests: [],
    requestPaths: [],
    fileListQueries: [],
    seenAuthorization: [],
    memoryBodies: [],
    trainBodies: [],
    trainSessionRequests: 0,
    trainUploads: [],
    trainPolls: 0,
    trainFailure: false,
    trainStuck: false,
    agentPrompts: [],
    deviceCodeBodies: [],
    deviceTokenStatus: 'approved',
    deviceExpiresIn: 900,
  }
  const port = await freePort()
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request: Request) {
      const url = new URL(request.url)
      state.apiRequests.push({ method: request.method, path: url.pathname })
      if (url.pathname === '/duet.tgz' && state.tarball !== undefined) {
        return new Response(state.tarball as unknown as ConstructorParameters<typeof Response>[0], {
          headers: { 'content-type': 'application/gzip' },
        })
      }
      if (url.pathname === '/v1/device/code' && request.method === 'POST') {
        state.deviceCodeBodies.push(
          (await request.json().catch(() => ({}))) as Record<string, unknown>,
        )
        return Response.json({
          device_code: 'a'.repeat(64),
          user_code: 'ABCD-2345',
          verification_uri: `${url.origin}/device`,
          expires_in: state.deviceExpiresIn,
          interval: 1,
        })
      }
      if (url.pathname === '/v1/device/token' && request.method === 'POST') {
        if (state.deviceTokenStatus === 'pending')
          return Response.json({ status: 'pending', interval: 1 })
        return Response.json({
          status: 'approved',
          access_token: SECRET_KEY,
          token_type: 'bearer',
          prefix: 'duet_sk_mock',
        })
      }
      // The VM upload PUT authenticates with the gateway upload token, not the
      // api key — it must bypass the api-key gate below (one mock server plays
      // both hosts).
      if (url.pathname.startsWith('/v1/train/uploads/') && request.method === 'PUT') {
        const bytes = Buffer.from(await request.arrayBuffer())
        state.trainUploads.push({
          filename: decodeURIComponent(url.pathname.slice('/v1/train/uploads/'.length)),
          authorization: request.headers.get('authorization'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
        return Response.json({ filename: 'profile.bin', size: bytes.byteLength, uploadedAt: 1 })
      }
      const auth = request.headers.get('authorization')
      state.seenAuthorization.push(auth ?? '')
      if (auth !== `Bearer ${SECRET_KEY}`)
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      state.requestPaths.push(url.pathname)
      if (url.pathname === '/v1/whoami') return Response.json(mockWhoami())
      if (url.pathname === '/v1/workspaces' && request.method === 'POST')
        return Response.json({ workspace: mockWhoami().workspaces[0] }, { status: 202 })
      if (url.pathname === '/v1/ws/demo/memories' && request.method === 'POST') {
        state.memoryBodies.push((await request.json()) as Record<string, unknown>)
        const body = state.memoryBodies.at(-1)!
        return Response.json({
          id: `mem_${state.memoryBodies.length}`,
          content: body.content,
          kind: 'note',
          source: body.source,
          createdAt: '2026-07-06T00:00:00.000Z',
        })
      }
      if (url.pathname === '/v1/ws/demo/memories/search') {
        const query = url.searchParams.get('q') ?? ''
        const results = state.memoryBodies
          .map((body, index) => ({
            id: `mem_${index + 1}`,
            content: String(body.content ?? ''),
            kind: 'note',
            source: body.source,
            priority: 'medium',
            createdAt: '2026-07-06T00:00:00.000Z',
            lastUsedAt: '2026-07-06T00:00:00.000Z',
            observedDate: '2026-07-06',
            tags: [],
            relevanceScore: String(body.content ?? '').includes(query) ? 1 : 0,
          }))
          .filter(record => record.relevanceScore > 0)
        return Response.json({
          query,
          limit: Number(url.searchParams.get('limit') ?? '10'),
          results,
        })
      }
      if (url.pathname === '/v1/ws/demo/billing/usage') {
        return Response.json({
          period: url.searchParams.get('period'),
          group: url.searchParams.get('group'),
          rows: [
            { workspaceId: 'ws_1', period: '2026-07-06', appSlug: 'site', spendMicroUsd: 370_000 },
          ],
        })
      }
      if (url.pathname === '/v1/ws/demo/train/uploads/session' && request.method === 'POST') {
        state.trainSessionRequests += 1
        return Response.json({
          vmBaseUrl: `${url.origin}/`,
          uploadToken: 'mock_upload_token',
          expiresAt: Date.now() + 60_000,
        })
      }
      if (url.pathname === '/v1/ws/demo/train/uploads/url' && request.method === 'POST') {
        const body = (await request.json()) as { url: string }
        return Response.json(
          { filename: 'source.md', size: body.url.length, uploadedAt: Date.now(), url: body.url },
          { status: 201 },
        )
      }
      if (url.pathname === '/v1/ws/demo/train' && request.method === 'POST') {
        const text = await request.text()
        state.trainBodies.push(
          text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>),
        )
        state.trainPolls = 0
        return Response.json({
          jobId: 'train_1',
          job: { jobId: 'train_1', workspaceId: 'ws_1', state: 'queued', phase: 'preparing' },
        })
      }
      if (url.pathname === '/v1/ws/demo/train/train_1') {
        state.trainPolls += 1
        if (state.trainFailure) {
          return Response.json({
            job: {
              jobId: 'train_1',
              workspaceId: 'ws_1',
              state: 'failed',
              phase: 'failed',
              error: 'mock train failed',
            },
          })
        }
        const stateName = state.trainStuck ? 'running' : state.trainPolls === 1 ? 'running' : 'done'
        return Response.json({
          job: {
            jobId: 'train_1',
            workspaceId: 'ws_1',
            state: stateName,
            phase: stateName === 'done' ? 'done' : 'training',
          },
        })
      }
      if (url.pathname === '/v1/ws/demo/agent/sessions' && request.method === 'POST') {
        const body = (await request.json()) as { prompt?: string }
        state.agentPrompts.push(body.prompt ?? '')
        return Response.json({
          session: { sessionId: 'sess_1', status: 'running', lastEventSeq: 1 },
        })
      }
      if (url.pathname === '/v1/ws/demo/agent/sessions/sess_1/events') {
        return new Response(
          [
            'id: 2',
            'event: turn_started',
            'data: {"seq":2,"event":{"type":"turn_started","state":{"status":"running","mode":"agent","agent":{"status":"running","messages":[]}}}}',
            '',
            'event: step',
            'data: {"event":{"type":"step","step":{"type":"text_delta","delta":"Hello "}}}',
            '',
            'data: {"event":{"type":"step","step":{"type":"text_delta","delta":"live "}}}',
            '',
            'data: {"event":{"type":"step","step":{"type":"text_delta","delta":"stream"}}}',
            '',
            'id: 3',
            'event: step',
            'data: {"seq":3,"event":{"type":"step","step":{"type":"text","text":"Hello live stream"}}}',
            '',
            'event: step',
            'data: {"event":{"type":"step","step":{"type":"tool_call_start","toolName":"read_file","toolCallId":"call-1","input":{"path":"README.md"}}}}',
            '',
            'id: 4',
            'event: step',
            'data: {"seq":4,"event":{"type":"step","step":{"type":"tool_call","toolName":"read_file","toolCallId":"call-1","input":{"path":"README.md"},"isError":false,"output":[{"type":"text","text":"ok"}]}}}',
            '',
            'id: 5',
            'event: complete',
            'data: {"seq":5,"event":{"type":"complete","state":{"status":"completed","mode":"agent","agent":{"status":"completed","messages":[]}},"status":"completed","result":"done"}}',
            '',
            'id: 6',
            'event: system',
            'data: {"seq":6,"event":{"type":"step","step":{"type":"system","message":"after terminal"}}}',
            '',
            '',
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (
        url.pathname === '/v1/ws/demo/agent/sessions/sess_1/answer' &&
        request.method === 'POST'
      ) {
        const body = (await request.json()) as { answer?: string }
        return Response.json({ ok: true, answer: body.answer })
      }
      if (
        url.pathname === '/v1/ws/demo/agent/sessions/sess_1/interrupt' &&
        request.method === 'POST'
      ) {
        return Response.json({ ok: true, interrupted: true })
      }
      if (url.pathname === '/v1/ws/demo/file-activity') {
        state.fileActivityQueries.push(`${url.pathname}${url.search}`)
        return Response.json(mockFileHistoryPage())
      }
      if (url.pathname === '/v1/ws/demo/file-activity/seen-by') {
        state.fileActivityQueries.push(`${url.pathname}${url.search}`)
        return Response.json(mockSeenBy())
      }
      if (url.pathname.startsWith('/v1/ws/demo/files'))
        return await handleFiles(request, url, state)
      return Response.json({ error: 'not_found' }, { status: 404 })
    },
  })
  try {
    await run({
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      state,
    })
  } finally {
    server.stop(true)
  }
  expect(unsupportedApiRequests(state.apiRequests)).toEqual([])
}

function unsupportedApiRequests(
  requests: Array<{ method: string; path: string }>,
): Array<{ method: string; path: string }> {
  return requests.filter(request => {
    if (request.method === 'PUT' && request.path.startsWith('/v1/train/uploads/')) return false
    return !PUBLIC_API_ENDPOINTS.some(endpoint => {
      if (endpoint.method !== request.method) return false
      const path = endpoint.path.split('?')[0]!
      const pattern = path
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace('/\\{path\\}', '(?:/.*)?')
        .replace(/\\\{[^/]+\\\}/g, '[^/]+')
      return new RegExp(`^${pattern}$`).test(request.path)
    })
  })
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error !== undefined) reject(error)
        else if (typeof address === 'object' && address !== null) resolve(address.port)
        else reject(new Error('No free port found'))
      })
    })
    server.on('error', reject)
  })
}

async function handleFiles(request: Request, url: URL, state: MockState): Promise<Response> {
  const path = decodeURIComponent(url.pathname.slice('/v1/ws/demo/files'.length) || '/')
  if (path === '/forbidden')
    return Response.json(
      { error: 'insufficient_scope', scope: 'ws:demo:files:read' },
      { status: 403 },
    )
  if (path === '/actions' && request.method === 'POST') {
    state.fileActionBodies.push((await request.json()) as Record<string, unknown>)
    return Response.json({ ok: true, affectedEntries: 1 })
  }
  if (request.method === 'GET' && url.searchParams.get('list') === '1') {
    state.fileListQueries.push(`${url.pathname}?${url.searchParams}`)
    return Response.json({
      items: [...state.files.entries()].map(([name, bytes]) => ({
        name: name.slice(1),
        path: name.slice(1),
        type: 'file',
        size: bytes.byteLength,
        mtime: '2026-07-06T00:00:00.000Z',
      })),
      nextCursor: null,
    })
  }
  if (request.method === 'PUT') {
    const bytes = new Uint8Array(await request.arrayBuffer())
    state.files.set(path, bytes)
    return Response.json(
      { ok: true, etag: '"mock-etag"', size: bytes.byteLength },
      { headers: { etag: '"mock-etag"' } },
    )
  }
  if (request.method === 'GET') {
    const bytes = state.files.get(path)
    if (bytes === undefined) return Response.json({ error: 'not_found' }, { status: 404 })
    return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], {
      headers: { 'content-type': 'application/octet-stream' },
    })
  }
  if (request.method === 'DELETE') {
    state.files.delete(path)
    return Response.json({ ok: true })
  }
  return Response.json({ error: 'not_found' }, { status: 404 })
}

function mockFileHistoryPage() {
  return {
    items: [
      {
        seq: 1,
        event: {
          kind: 'create',
          entryKind: 'file',
          path: 'notes/plan.md',
          actor: 'web:user1',
          userId: 'user1',
          at: 1_000,
        },
      },
      {
        seq: 5,
        event: { kind: 'restore', actor: 'system', at: 5_000 },
      },
      {
        seq: 6,
        event: {
          kind: 'rename',
          entryKind: 'file',
          path: 'notes/plan.md',
          fromPath: 'notes/draft.md',
          actor: 'terminal',
          at: 6_000,
        },
      },
    ],
    nextCursor: 'opaque-6',
  }
}

function mockSeenBy() {
  return {
    items: [
      {
        actor: 'web:user1',
        userId: 'user1',
        firstAt: 1_000,
        lastAt: 7_000,
        lastWriteAt: 1_000,
        readCount: 4,
        writeCount: 1,
      },
      { actor: 'session:ses1', firstAt: 2_000, lastAt: 2_000, readCount: 0, writeCount: 1 },
    ],
    nextCursor: null,
  }
}

function mockWhoami() {
  return {
    user: { id: 'user_1', email: 'agent@example.com', name: 'Agent' },
    workspaces: [
      {
        id: 'ws_1',
        slug: 'demo',
        name: 'Demo',
        status: 'active',
        servicingStatus: 'active',
        role: 'owner',
        billingUserId: 'user_1',
        defaultTier: { effective: 'standard' },
      },
    ],
    scopes: ['ws:demo:files:read', 'ws:demo:files:write', 'ws:demo:memory', 'ws:demo:services'],
    versions: { api: 1 },
    internalAdmin: false,
  }
}

interface MockApi {
  port: number
  baseUrl: string
  state: MockState
}

interface MockState {
  files: Map<string, Uint8Array>
  fileActionBodies: Array<Record<string, unknown>>
  fileActivityQueries: string[]
  apiRequests: Array<{ method: string; path: string }>
  requestPaths: string[]
  fileListQueries: string[]
  seenAuthorization: string[]
  memoryBodies: Array<Record<string, unknown>>
  trainBodies: Array<Record<string, unknown> | null>
  trainSessionRequests: number
  trainUploads: Array<{ filename: string; authorization: string | null; sha256: string }>
  trainPolls: number
  trainFailure: boolean
  trainStuck: boolean
  agentPrompts: string[]
  tarball?: Buffer
  deviceCodeBodies: Array<Record<string, unknown>>
  deviceTokenStatus: 'approved' | 'pending'
  deviceExpiresIn: number
}

function dockerTestsOptedIn(): boolean {
  return process.env.RUN_DOCKER_TESTS === '1'
}

function dockerRunScript(script: string, timeoutMs: number, volumes: string[] = []): string {
  const volumeArgs = volumes.flatMap(volume => ['-v', volume])
  return execFileSync(
    'docker',
    ['run', '--rm', ...volumeArgs, 'oven/bun:1.3.14', 'bash', '-lc', script],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
}
