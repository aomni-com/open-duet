import { expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { testIfDocker } from '../../agent/test/helpers/docker-only.js'

const CLI_ENTRY = resolve(import.meta.dir, process.env.DUET_TEST_CLI_ENTRY ?? '../src/cli-entry.ts')
const EXPORTED = {
  credentialId: 'exported-credential',
  prefix: 'duet_sk_display',
  createdAt: 1791244800000,
  expiresAt: null,
  key: 'duet_sk_SYNTHETIC_EXPORT_ONLY',
  apiUrl: 'https://ctl.fixture.test',
  gatewayBaseUrl: 'https://gateway.fixture.test',
}

testIfDocker(
  'dispatches app credential export with the VM bearer and returns one JSON object',
  async () => {
    const requests: { path: string; method: string; bearer: string | null; body: unknown }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          method: request.method,
          bearer: request.headers.get('authorization'),
          body: await request.json(),
        })
        return Response.json(EXPORTED, { status: 201 })
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    try {
      const result = await invoke(
        ['export', '--workspace', 'demo', '--app', 'new/era%', '--expiration', 'never', '--json'],
        root,
        { DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY', DUET_API_URL: server.url.href },
      )
      expect(result).toEqual({ exitCode: 0, stdout: `${JSON.stringify(EXPORTED)}\n`, stderr: '' })
      expect(requests).toEqual([
        {
          path: '/v1/ws/demo/apps/new%2Fera%25/credentials/export',
          method: 'POST',
          bearer: 'Bearer duet_sk_SYNTHETIC_VM_ONLY',
          body: { expiration: 'never' },
        },
      ])
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

testIfDocker(
  'invalid export responses never expose parser excerpts and preserve the recovery message',
  async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts++
        return attempts === 1
          ? new Response(`duet_sk_INVALID_JSON_ONLY ${EXPORTED.key}`, { status: 201 })
          : Response.json({ ...EXPORTED, prefix: null }, { status: 201 })
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await invoke(
          ['export', '--workspace', 'demo', '--app', 'newera', '--expiration', 'never', '--json'],
          root,
          {
            DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY',
            DUET_API_URL: server.url.href,
          },
        )
        expect(result).toEqual({
          exitCode: 1,
          stdout: '',
          stderr: `${JSON.stringify({ error: 'invalid_response', message: 'Export result is unknown. List credentials and revoke unwanted entries before exporting again.', status: 201 })}\n`,
        })
      }
      expect(attempts).toBe(2)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

testIfDocker(
  'app credential help exposes the command surface without needing authentication',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    try {
      const result = await invoke(['--help'], root)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(
        'duet app credentials export --workspace <slug> --app <slug> --expiration never|<seconds>',
      )
      expect(result.stdout).toContain('duet app credentials ls --workspace <slug> --app <slug>')
      expect(result.stdout).toContain(
        'duet app credentials revoke <credentialId> --workspace <slug> --app <slug>',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

testIfDocker(
  'invalid flags and expiry choices fail before HTTP with usage status',
  async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts++
        return Response.json(EXPORTED, { status: 201 })
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    const env = { DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY', DUET_API_URL: server.url.href }
    const required = ['--workspace', 'demo', '--app', 'newera']
    const invalidInvocations = [
      ['export', ...required],
      ...['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740991'].map(expiration => [
        'export',
        ...required,
        '--expiration',
        expiration,
      ]),
      ['export', '--app', 'newera', '--expiration', 'never'],
      ['export', '--workspace', 'demo', '--expiration', 'never'],
      ['export', ...required, '--expiration', 'never', '--unknown-secret-argument'],
      ['ls', ...required, '--expiration', 'never'],
      ['revoke', ...required],
    ]
    try {
      for (const args of invalidInvocations) {
        const result = await invoke([...args, '--json'], root, env)
        expect(result.exitCode).toBe(64)
        expect(result.stdout).toBe('')
        expect(JSON.parse(result.stderr).error).toBe('usage')
      }
      expect(attempts).toBe(0)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

testIfDocker(
  'ambiguous network export refuses redirects and explains inventory recovery without retrying',
  async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts++
        return new Response(null, { status: 302, headers: { location: '/duet_sk_REDIRECT_ONLY' } })
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    try {
      const result = await invoke(
        ['export', '--workspace', 'demo', '--app', 'newera', '--expiration', 'never', '--json'],
        root,
        {
          DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY',
          DUET_API_URL: server.url.href,
        },
      )
      expect(result).toEqual({
        exitCode: 6,
        stdout: '',
        stderr: `${JSON.stringify({ error: 'network_error', message: 'Export result is unknown. List credentials and revoke unwanted entries before exporting again.' })}\n`,
      })
      expect(attempts).toBe(1)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

testIfDocker(
  'metadata operations project only credential metadata and successful revoke acknowledgement',
  async () => {
    const metadata = {
      credentialId: EXPORTED.credentialId,
      prefix: EXPORTED.prefix,
      createdAt: EXPORTED.createdAt,
      expiresAt: null,
    }
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return Response.json(
          request.method === 'GET'
            ? {
                items: [{ ...metadata, key: EXPORTED.key, hashedKey: 'private-hash' }],
                nextCursor: null,
                key: 'duet_sk_UNEXPECTED_LIST_ONLY',
              }
            : { ok: true, key: EXPORTED.key },
        )
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    const env = { DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY', DUET_API_URL: server.url.href }
    try {
      const flags = ['--workspace', 'demo', '--app', 'newera', '--json']
      expect(await invoke(['ls', ...flags], root, env)).toEqual({
        exitCode: 0,
        stdout: `${JSON.stringify({ items: [metadata], nextCursor: null })}\n`,
        stderr: '',
      })
      expect(await invoke(['revoke', 'exported-credential', ...flags], root, env)).toEqual({
        exitCode: 0,
        stdout: '{"ok":true}\n',
        stderr: '',
      })
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

testIfDocker(
  'failed export reports safe HTTP status in JSON without exposing bodies or retrying',
  async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts++
        return Response.json(
          { error: 'duet_sk_ERROR_BODY_ONLY', key: EXPORTED.key },
          { status: 409 },
        )
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    try {
      const result = await invoke(
        ['export', '--workspace', 'demo', '--app', 'newera', '--expiration', 'never', '--json'],
        root,
        {
          DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY',
          DUET_API_URL: server.url.href,
        },
      )
      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr:
          '{"error":"request_failed","message":"App credentials request failed.","status":409}\n',
      })
      expect(attempts).toBe(1)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

async function invoke(args: string[], cwd: string, env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: cwd }
  delete childEnv.DUET_API_KEY
  delete childEnv.DUET_API_URL
  delete childEnv.DUET_API_BASE_URL
  const child = Bun.spawn([process.execPath, CLI_ENTRY, 'app', 'credentials', ...args], {
    cwd,
    env: { ...childEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill(), 15_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

testIfDocker('401 credential refusal preserves only safe category and HTTP status', async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(
        { error: 'duet_sk_UNSAFE_ERROR_ONLY', key: EXPORTED.key },
        { status: 401 },
      )
    },
  })
  const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
  try {
    const result = await invoke(['ls', '--workspace', 'demo', '--app', 'newera', '--json'], root, {
      DUET_API_KEY: 'duet_sk_SYNTHETIC_VM_ONLY',
      DUET_API_URL: server.url.href,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({
      error: 'unauthorized',
      message: 'App credentials request failed.',
      status: 401,
    })
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

testIfDocker(
  'finite export uses the saved human login and keeps token stdout separate from metadata',
  async () => {
    const finiteExport = { ...EXPORTED, expiresAt: 1791244860000 }
    const requests: unknown[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({ body: await request.json(), bearer: request.headers.get('authorization') })
        return Response.json(finiteExport, { status: 201 })
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    const envText = JSON.stringify({
      apiKey: 'duet_sk_SYNTHETIC_HUMAN_ONLY',
      apiUrl: server.url.href,
      defaultWorkspace: 'ignored',
    })
    await mkdir(join(root, '.duet'))
    await writeFile(join(root, '.duet', 'config.json'), envText)
    try {
      const result = await invoke(
        ['export', '--workspace', 'demo', '--app', 'newera', '--expiration', '60'],
        root,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${EXPORTED.key}\n`)
      const { key: _key, ...metadata } = finiteExport
      expect(JSON.parse(result.stderr)).toEqual(metadata)
      expect(requests).toEqual([
        { body: { expiration: { seconds: 60 } }, bearer: 'Bearer duet_sk_SYNTHETIC_HUMAN_ONLY' },
      ])
      expect(await readFile(join(root, '.duet', 'config.json'), 'utf8')).toBe(envText)
      expect(await readdir(join(root, '.duet'))).toEqual(['config.json'])
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

testIfDocker(
  'lists exported metadata and revokes one encoded credential through the same API base',
  async () => {
    const { key: _key, apiUrl: _apiUrl, gatewayBaseUrl: _gateway, ...metadata } = EXPORTED
    const inventory = { items: [metadata], nextCursor: null }
    const requests: { path: string; method: string; bearer: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          method: request.method,
          bearer: request.headers.get('authorization'),
        })
        return Response.json(request.method === 'GET' ? inventory : { ok: true })
      },
    })
    const root = await mkdtemp(join(tmpdir(), 'duet-app-credentials-'))
    const env = { DUET_API_KEY: 'duet_sk_SYNTHETIC_USER_ONLY', DUET_API_URL: server.url.href }
    const flags = ['--workspace', 'demo', '--app', 'newera', '--json']
    try {
      expect(await invoke(['ls', ...flags], root, env)).toEqual({
        exitCode: 0,
        stdout: `${JSON.stringify(inventory)}\n`,
        stderr: '',
      })
      expect(await invoke(['revoke', 'credential/%', ...flags], root, env)).toEqual({
        exitCode: 0,
        stdout: '{"ok":true}\n',
        stderr: '',
      })
      expect(requests).toEqual([
        {
          path: '/v1/ws/demo/apps/newera/credentials',
          method: 'GET',
          bearer: 'Bearer duet_sk_SYNTHETIC_USER_ONLY',
        },
        {
          path: '/v1/ws/demo/apps/newera/credentials/credential%2F%25',
          method: 'DELETE',
          bearer: 'Bearer duet_sk_SYNTHETIC_USER_ONLY',
        },
      ])
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)
