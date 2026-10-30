import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Runs only inside the disposable image verifier, against controlled loopback APIs.
const root = await mkdtemp(join(tmpdir(), 'duet-fresh-runtime-'))
const manifest = await Bun.file('/opt/duet/current/manifest.json').json()
const imageVersion = `ghcr.io/aomni-com/duet-vm-image@sha256:${'4'.repeat(64)}`
const vmToken = 'duet_vm_image_fixture'
const apiKey = 'duet_model_image_fixture'
const requests: Array<{ path: string; body: Record<string, unknown> }> = []
let messageCount = 0
let releaseFirst!: () => void
const firstAccepted = new Promise<void>(resolve => {
  releaseFirst = resolve
})
const server = Bun.serve({
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname
    const body = (await request.json()) as Record<string, unknown>
    requests.push({ path, body })
    if (path.endsWith('/messages')) {
      assert.equal(request.headers.get('x-api-key'), apiKey)
      messageCount += 1
      if (messageCount === 1) await firstAccepted
      return new Response(
        [
          [
            'message_start',
            {
              type: 'message_start',
              message: {
                id: `image-${messageCount}`,
                type: 'message',
                role: 'assistant',
                model: 'anthropic/claude-haiku-4-5',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          ],
          [
            'content_block_start',
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'image continuation' },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ]
          .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const sync = {
      pollAfterMs: 100,
      anchors: [],
      agents: [],
      apps: [],
      workspaceSlug: 'image-fixture',
      updates: { paused: true },
      ...(process.env.PROBE_OMIT_MODEL_CREDENTIALS !== '1'
        ? {
            modelCredentials: {
              apiKey,
              gatewayBaseUrl: server.url.origin,
              expiresAt: Date.now() + 24 * 60 * 60_000,
            },
          }
        : {}),
      mirrorMachineIds: [],
    }
    if (path === '/v1/vm/register') {
      assert.equal(body.provisioningToken, 'image-provisioning-fixture')
      assert.equal(body.runtimeVersion, manifest.version)
      assert.equal('gatewayVersion' in body, false)
      assert.equal(body.imageVersion, imageVersion)
      return Response.json({ vmToken, syncIntervalSeconds: 0.1, sync })
    }
    assert.equal(path, '/v1/vm/sync')
    assert.equal(request.headers.get('authorization'), `Bearer ${vmToken}`)
    assert.deepEqual(body.versions, {
      runtime: manifest.version,
      image: imageVersion,
    })
    return Response.json(sync)
  },
})
const portReservation = Bun.serve({ port: 0, fetch: () => new Response() })
const port = portReservation.port
portReservation.stop(true)
const home = join(root, 'home')
const state = join(home, '.duet')
await mkdir(state, { recursive: true })
const env = {
  ...process.env,
  HOME: home,
  PORT: String(port),
  DUET_STATE_DIR: state,
  DUET_DRIVE_DIR: join(root, 'drive'),
  DUET_API_URL: server.url.origin,
  DUET_WORKSPACE_HINT: 'image-fixture',
  DUET_PROVISIONING_TOKEN: 'image-provisioning-fixture',
  DUET_IMAGE_VERSION: imageVersion,
}
const bootstrap = Bun.spawn(
  ['/opt/duet/gateway-runtime/bin/bun', '/opt/duet/bin/runtime-bootstrap.js'],
  { env, stdout: 'pipe', stderr: 'pipe' },
)
try {
  const [code, stdout, stderr] = await Promise.all([
    bootstrap.exited,
    new Response(bootstrap.stdout).text(),
    new Response(bootstrap.stderr).text(),
  ])
  assert.equal(code, 0, `${stdout}\n${stderr}`)
} catch (error) {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
  throw error
}
const gateway = Bun.spawn(['/opt/duet/gateway-runtime/bin/bun', '/opt/duet/current/index.js'], {
  env,
  stdout: 'pipe',
  stderr: 'pipe',
})
const logs = Promise.all([new Response(gateway.stdout).text(), new Response(gateway.stderr).text()])
let rpc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
const timeout = setTimeout(() => {
  gateway.kill('SIGKILL')
  rpc?.kill('SIGKILL')
}, 100_000)
try {
  let credentials: { apiKey: string; gatewayBaseUrl: string } | undefined
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      credentials = JSON.parse(await readFile(join(state, 'model-credentials.json'), 'utf8'))
    } catch {}
    if (credentials && requests.some(request => request.path === '/v1/vm/sync')) break
    if (gateway.exitCode !== null) throw new Error(`gateway exited: ${await logs}`)
    await Bun.sleep(50)
  }
  assert.equal(await readFile(join(state, 'vm-token'), 'utf8'), `${vmToken}\n`)
  assert.equal((await stat(join(state, 'vm-token'))).mode & 0o777, 0o600)
  assert.equal(
    credentials?.apiKey,
    apiKey,
    'fresh registration must deliver and persist model credentials',
  )
  assert.equal(credentials?.gatewayBaseUrl, server.url.origin)
  assert.equal(requests.filter(request => request.path === '/v1/vm/register').length, 1)
  let certified = false
  const certificationDeadline = Date.now() + 75_000
  while (Date.now() < certificationDeadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${vmToken}` },
    })
    if (response.ok) {
      const health = (await response.json()) as {
        runtimeVersion: string
        imageVersion: string
        diagnostics: { bootHealthCertified: boolean }
      }
      assert.equal(health.runtimeVersion, manifest.version)
      assert.equal(health.imageVersion, imageVersion)
      if (health.diagnostics.bootHealthCertified) {
        certified = true
        break
      }
    }
    if (gateway.exitCode !== null)
      throw new Error(`gateway exited before certification: ${await logs}`)
    await Bun.sleep(500)
  }
  assert(certified, 'fresh runtime must survive probation and certify through real syncs')
  rpc = Bun.spawn(
    [
      '/usr/local/bin/duet',
      '--rpc',
      '--incognito',
      '--no-system-prompt-files',
      '--model',
      'duet:anthropic/claude-haiku-4-5',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        DUET_API_KEY: credentials!.apiKey,
        DUET_GATEWAY_BASE_URL: credentials!.gatewayBaseUrl,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const processRpc = rpc
  const stderr = new Response(processRpc.stderr).text()
  const events: Array<{ type: string; requestId?: string; status?: string }> = []
  processRpc.stdin.write(
    `${JSON.stringify({ type: 'start' })}\n${JSON.stringify({ type: 'prompt', requestId: 'first', message: 'First image turn.', behavior: 'follow_up' })}\n`,
  )
  await processRpc.stdin.flush()
  let remainder = ''
  for await (const chunk of processRpc.stdout) {
    remainder += new TextDecoder().decode(chunk)
    const lines = remainder.split('\n')
    remainder = lines.pop()!
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line)
      events.push(event)
      if (event.type === 'command_accepted' && event.requestId === 'first') {
        processRpc.stdin.write(
          `${JSON.stringify({ type: 'prompt', requestId: 'second', message: 'Continue image turn.', behavior: 'follow_up' })}\n`,
        )
        await processRpc.stdin.flush()
      }
      if (event.type === 'command_accepted' && event.requestId === 'second') releaseFirst()
      if (event.type === 'complete') {
        assert.equal(event.status, 'completed')
        processRpc.stdin.end()
      }
    }
  }
  assert.equal(await processRpc.exited, 0, await stderr)
  for (const id of ['first', 'second'])
    assert(events.some(event => event.type === 'command_accepted' && event.requestId === id))
  assert.equal(events.filter(event => event.type === 'complete').length, 1)
  assert.equal(messageCount, 2)
  console.log(
    `PASS fresh ${process.env.PROBE_API_GENERATION ?? 'new'} API registration, exact runtime/image reports, durable VM token, delivered model credential, sustained boot certification, real CLI RPC continuation`,
  )
} finally {
  clearTimeout(timeout)
  releaseFirst()
  rpc?.kill()
  gateway.kill()
  await gateway.exited
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
