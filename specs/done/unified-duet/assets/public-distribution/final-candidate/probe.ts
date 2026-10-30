import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Only the HTTP and launchctl edges are fixtures. Run the installed public CLI.
const entry = process.argv[2]!
const evidence = process.argv[3]!
const home = await mkdtemp(join(tmpdir(), 'duet-public-journey-'))
const key = 'duet_sk_external_fixture'
const files = new Map<string, Uint8Array>()
const calls: Array<{ method: string; path: string }> = []
let registrations = 0
let deviceId: string | undefined
const user = { id: 'external-person', email: 'user@example.invalid' }
const server = Bun.serve({
  hostname: '192.0.2.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    calls.push({ method: request.method, path: url.pathname })
    if (url.pathname === '/v1/device/code') {
      assert.deepEqual(await request.json(), { client_name: 'Duet CLI' })
      return Response.json({
        device_code: 'a'.repeat(64),
        user_code: 'ABCD-2345',
        verification_uri: `${url.origin}/device`,
        expires_in: 900,
        interval: 1,
      })
    }
    if (url.pathname === '/v1/device/token')
      return Response.json({
        status: 'approved',
        access_token: key,
        token_type: 'bearer',
        prefix: 'duet_sk_fixture',
      })
    assert.equal(request.headers.get('authorization'), `Bearer ${key}`)
    if (url.pathname === '/v1/whoami')
      return Response.json({
        user,
        workspaces: [{ id: 'workspace-fixture', slug: 'demo', name: 'Demo', role: 'owner' }],
        scopes: ['ws:demo:files:read', 'ws:demo:files:write'],
        versions: { api: 1 },
      })
    if (url.pathname === '/v1/user/sync-machines') {
      const body = (await request.json()) as { name: string; syncthingDeviceId: string }
      assert.deepEqual(Object.keys(body).sort(), ['name', 'syncthingDeviceId'])
      assert.match(body.syncthingDeviceId, /^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/)
      deviceId ??= body.syncthingDeviceId
      assert.equal(body.syncthingDeviceId, deviceId)
      registrations++
      return Response.json({ machineId: 'external-mac', ...body, createdAt: 1, lastUsedAt: 1 })
    }
    if (url.pathname.startsWith('/v1/ws/demo/files/')) {
      const path = decodeURIComponent(url.pathname.slice('/v1/ws/demo/files/'.length))
      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        files.set(path, bytes)
        return Response.json({ ok: true, etag: '"fixture"', size: bytes.length })
      }
      const bytes = files.get(path)
      return bytes ? new Response(bytes) : Response.json({ error: 'not_found' }, { status: 404 })
    }
    throw new Error(`Unexpected fixture request ${request.method} ${url.pathname}`)
  },
})
const results: Record<string, unknown> = {}
const env = {
  PATH: `${join(home, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  DUET_NO_AUTO_UPGRADE: '1',
}
async function run(args: string[], expected = 0) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: home,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  const [output, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const stdoutBytes = Buffer.from(output)
  const stdout = stdoutBytes.toString('utf8')
  assert.equal(code, expected, JSON.stringify({ args, code, stdout, stderr }))
  assert(!`${stdout}${stderr}`.includes(key))
  return { stdout, stdoutBytes, stderr, code }
}
try {
  const manifest = JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@duetso/agent')
  assert.equal(manifest.version, '1.0.0')
  assert.deepEqual(manifest.bin, { duet: 'dist/cli-entry.js' })
  assert(!JSON.stringify(manifest).includes('workspace:'))
  results.version = await run(['--version'])
  assert.equal((results.version as { stdout: string }).stdout, '1.0.0\n')
  results.login = await run(['--api-url', server.url.origin, '--json', 'login', '--no-browser'])
  results.whoami = await run(['--json', 'whoami'])
  assert.deepEqual(JSON.parse((results.whoami as { stdout: string }).stdout).user, user)
  results.workspace = await run(['workspace', 'use', 'demo'])
  const configPath = join(home, '.duet', 'config.json')
  const login = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(login.apiKey, key)
  assert.equal(login.defaultWorkspace, 'demo')
  await writeFile(join(home, 'bytes.bin'), Buffer.from([0, 1, 2, 250, 255, 10]))
  results.push = await run(['--json', 'push', join(home, 'bytes.bin'), 'demo:/bytes.bin'])
  const cat = await run(['cat', 'demo:/bytes.bin'])
  assert.deepEqual(cat.stdoutBytes, Buffer.from([0, 1, 2, 250, 255, 10]))
  results.cat = { code: cat.code, bytes: [...cat.stdoutBytes], stderr: cat.stderr }
  assert.deepEqual(files.get('bytes.bin'), new Uint8Array([0, 1, 2, 250, 255, 10]))
  results.syncStatus = await run(['--json', 'sync', 'status'])
  assert.deepEqual(JSON.parse((results.syncStatus as { stdout: string }).stdout), {
    ok: false,
    running: false,
    workspaces: [],
  })
  if (process.platform === 'darwin') {
    await mkdir(join(home, 'bin'))
    await writeFile(
      join(home, 'bin', 'launchctl'),
      '#!/bin/sh\ncase "$1" in\n bootstrap) : > "$HOME/loaded" ;;\n bootout) if test -f "$HOME/loaded"; then rm "$HOME/loaded"; else exit 3; fi ;;\n *) exit 64 ;;\nesac\n',
    )
    await chmod(join(home, 'bin', 'launchctl'), 0o755)
    results.syncInstall = await run(['--json', 'sync', 'install'])
    assert.equal(JSON.parse((results.syncInstall as { stdout: string }).stdout).syncthing, 'v2.1.2')
    const identity = join(home, '.duet', 'sync', 'identity')
    const certificate = await readFile(join(identity, 'cert.pem'))
    const privateKey = await readFile(join(identity, 'key.pem'))
    assert(certificate.includes('BEGIN CERTIFICATE'))
    await run(['--json', 'sync', 'install'])
    assert.deepEqual(await readFile(join(identity, 'cert.pem')), certificate)
    assert.deepEqual(await readFile(join(identity, 'key.pem')), privateKey)
    assert.equal(registrations, 2)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    assert.deepEqual(config, { ...login, machineId: 'external-mac' })
    results.syncUninstall = await run(['--json', 'sync', 'uninstall'])
    assert.equal(JSON.parse((results.syncUninstall as { stdout: string }).stdout).wasLoaded, true)
    assert.deepEqual(await readFile(join(identity, 'cert.pem')), certificate)
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config)
    const binary = join(
      dirname(dirname(dirname(dirname(entry)))),
      `@duetso/syncthing-darwin-${process.arch}`,
      'bin/syncthing',
    )
    results.syncthing = {
      arch: process.arch,
      sha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
      deviceId,
      certificateSha256: createHash('sha256').update(certificate).digest('hex'),
    }
  } else {
    const rejected = await run(['--json', 'sync', 'install'], 1)
    assert(rejected.stderr.includes('unsupported_platform'))
    results.syncPlatform = 'Stock optional Syncthing is macOS only; Linux rejection verified.'
  }
  await mkdir(evidence, { recursive: true })
  await writeFile(
    join(evidence, 'journey.json'),
    JSON.stringify(
      {
        process: { bun: Bun.version, arch: process.arch, platform: process.platform },
        manifest,
        results,
        calls,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    'PASS installed public CLI: one login, whoami, explicit workspace, file bytes, sync initialization and preserved identity/login',
  )
} finally {
  server.stop(true)
  await rm(home, { recursive: true, force: true })
}
