import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

async function runExample(
  options: {
    cliAvailable?: boolean
    legacyCli?: boolean
    exportStatus?: number
    hostFailure?: boolean
    malformedResponse?: boolean
  } = {},
) {
  const reference = await readFile(
    path.join(import.meta.dir, '../skills/build-apps/reference/external-hosting.md'),
    'utf8',
  )
  const source = reference.match(/```typescript\n([\s\S]*?)\n```/)?.[1]
  expect(source).toBeDefined()
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'duet-external-app-skill-')))
  temporaryDirectories.push(directory)
  const bin = path.join(directory, 'bin')
  await mkdir(bin)
  const receipts = path.join(directory, 'receipts.jsonl')
  const key = 'duet_sk_CONTROLLED_EXPORT_SECRET'
  const exported = {
    credentialId: 'new-export',
    prefix: 'duet_sk_CONTROLLED',
    createdAt: 1,
    expiresAt: null,
    key,
    apiUrl: 'https://returned-api.example',
    gatewayBaseUrl: 'https://returned-gateway.example',
  }
  const cliFixture = `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes('--help')) { console.log(${JSON.stringify(options.legacyCli ? 'duet --help: run an agent or model' : 'duet app credentials export --workspace <slug> --app <slug> --expiration <never|seconds> --json')}); process.exit(${options.cliAvailable === false ? 1 : 0}); }\nawait Bun.write(Bun.env.RECEIPTS, (await Bun.file(Bun.env.RECEIPTS).text().catch(() => '')) + JSON.stringify({tool: 'duet', args}) + '\\n');\nconsole.log(${JSON.stringify(JSON.stringify(exported))});\n`
  const hostFixture = `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst value = await Bun.stdin.text();\nconst receipt = {tool: 'vercel', args, cwd: process.cwd(), value};\nawait Bun.write(Bun.env.RECEIPTS, (await Bun.file(Bun.env.RECEIPTS).text().catch(() => '')) + JSON.stringify(receipt) + '\\n');\nif (${options.hostFailure ?? false}) process.exit(1); console.log('https://controlled-deployment.example');\n`
  await writeFile(path.join(bin, 'duet'), cliFixture, { mode: 0o755 })
  await writeFile(path.join(bin, 'vercel'), hostFixture, { mode: 0o755 })
  const apiRequests: Array<{
    url: string
    method: string
    authorization: string | null
    body: unknown
  }> = []
  const api = Bun.serve({
    port: 0,
    fetch: async request => {
      apiRequests.push({
        url: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get('authorization'),
        body: await request.json(),
      })
      if (options.malformedResponse) return new Response(key, { status: 201 })
      return Response.json(
        options.exportStatus === 409
          ? { error: 'app_credential_limit', limit: 5, plantedSecret: key }
          : exported,
        { status: options.exportStatus ?? 201 },
      )
    },
  })
  try {
    const example = path.join(directory, 'configure.ts')
    await writeFile(example, source!)
    const child = Bun.spawn([process.execPath, example], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RECEIPTS: receipts,
        DUET_API_URL: api.url.origin,
        DUET_API_KEY: 'duet_sk_CONTROLLED_BUILD_BEARER',
        WORKSPACE_SLUG: 'workspace',
        APP_SLUG: 'tracked-app',
        HOST_ENVIRONMENT: 'production',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const operations = (await readFile(receipts, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    return { stdout, stderr, exitCode, operations, apiRequests, directory, key, exported }
  } finally {
    api.stop(true)
  }
}

describe('authored external app deployment example', () => {
  test('captures the actual CLI export and configures the selected host before deploying without revealing credentials', async () => {
    const result = await runExample()
    expect(result.exitCode).toBe(0)
    expect(result.apiRequests).toEqual([])
    expect(result.operations).toEqual([
      {
        tool: 'duet',
        args: [
          'app',
          'credentials',
          'export',
          '--workspace',
          'workspace',
          '--app',
          'tracked-app',
          '--expiration',
          'never',
          '--json',
        ],
      },
      ...[
        ['DUET_APP_API_KEY', result.key],
        ['DUET_API_URL', result.exported.apiUrl],
        ['DUET_GATEWAY_BASE_URL', result.exported.gatewayBaseUrl],
      ].map(([name, value]) => ({
        tool: 'vercel',
        args: ['env', 'add', name, 'production', '--force', '--yes'],
        cwd: result.directory,
        value,
      })),
      { tool: 'vercel', args: ['deploy', '--yes', '--prod'], cwd: result.directory, value: '' },
    ])
    expect(result.stdout + result.stderr).not.toContain(result.key)
    expect(result.stdout + result.stderr).not.toContain('duet_sk_CONTROLLED_BUILD_BEARER')
  })

  test('uses the public API when the installed command is unavailable and preserves returned runtime origins', async () => {
    const result = await runExample({ cliAvailable: false })
    expect(result.exitCode).toBe(0)
    expect(result.apiRequests).toEqual([
      {
        url: '/v1/ws/workspace/apps/tracked-app/credentials/export',
        method: 'POST',
        authorization: 'Bearer duet_sk_CONTROLLED_BUILD_BEARER',
        body: { expiration: 'never' },
      },
    ])
    expect(
      result.operations
        .filter(operation => operation.args[0] === 'env')
        .map(operation => [operation.args[2], operation.value]),
    ).toEqual([
      ['DUET_APP_API_KEY', result.key],
      ['DUET_API_URL', result.exported.apiUrl],
      ['DUET_GATEWAY_BASE_URL', result.exported.gatewayBaseUrl],
    ])
    expect(result.operations.at(-1).args).toEqual(['deploy', '--yes', '--prod'])
    expect(result.stdout + result.stderr).not.toContain(result.key)
  })

  test('a full inventory refuses once without host changes, retries or raw error disclosure', async () => {
    const result = await runExample({ cliAvailable: false, exportStatus: 409 })
    expect(result.exitCode).not.toBe(0)
    expect(result.apiRequests).toEqual([
      {
        url: '/v1/ws/workspace/apps/tracked-app/credentials/export',
        method: 'POST',
        authorization: 'Bearer duet_sk_CONTROLLED_BUILD_BEARER',
        body: { expiration: 'never' },
      },
    ])
    expect(result.operations).toEqual([])
    expect(result.stderr).toContain('HTTP 409')
    expect(result.stdout + result.stderr).not.toContain(result.key)
    expect(result.stdout + result.stderr).not.toContain('plantedSecret')
  })

  test('generic legacy CLI help does not dispatch an unsupported command as an agent prompt', async () => {
    const result = await runExample({ legacyCli: true })
    expect(result.exitCode).toBe(0)
    expect(result.apiRequests).toEqual([
      {
        url: '/v1/ws/workspace/apps/tracked-app/credentials/export',
        method: 'POST',
        authorization: 'Bearer duet_sk_CONTROLLED_BUILD_BEARER',
        body: { expiration: 'never' },
      },
    ])
    expect(result.operations.every(operation => operation.tool === 'vercel')).toBe(true)
    expect(result.stdout + result.stderr).not.toContain(result.key)
  })

  test('host configuration failure retains only safe credential identity for cleanup and does not deploy', async () => {
    const result = await runExample({ hostFailure: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain(result.exported.credentialId)
    expect(result.operations.some(operation => operation.args[0] === 'deploy')).toBe(false)
    expect(result.stdout + result.stderr).not.toContain(result.key)
  })

  test('invalid export JSON cannot disclose secret-bearing response text through parsing diagnostics', async () => {
    const result = await runExample({ cliAvailable: false, malformedResponse: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.operations).toEqual([])
    expect(result.stderr).toContain('invalid JSON')
    expect(result.stdout + result.stderr).not.toContain(result.key)
  })
})
