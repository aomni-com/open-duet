import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ExeClient } from './exe'

const originalFetch = globalThis.fetch
const originalStderrWrite = process.stderr.write

afterEach(() => {
  globalThis.fetch = originalFetch
  process.stderr.write = originalStderrWrite
})

describe('ExeClient redaction', () => {
  test('redacts secret-bearing args from verbose logs and thrown errors', async () => {
    const stderr: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    globalThis.fetch = (async () =>
      new Response('failed with duet_sk_mock_secret and sk-proj-' + 'A'.repeat(48), {
        status: 500,
      })) as unknown as typeof fetch

    const client = new ExeClient({ token: 'exe-token', verbose: true })
    const registryAuth = 'user:very-secret-password'
    const envSecret = 'OPENAI_API_KEY=sk-proj-' + 'B'.repeat(48)

    let failure: unknown
    try {
      await client.create({
        image: 'registry.example/private:latest',
        registryAuth,
        env: [envSecret],
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toBe(
      'exe.dev command failed: new --image registry.example/private:latest --registry-auth [REDACTED] --env [REDACTED] --no-email (http 500)\nfailed with [REDACTED] and [REDACTED]',
    )

    const combined = stderr.join('\n')
    expect(combined).toContain('--registry-auth [REDACTED]')
    expect(combined).toContain('--env [REDACTED]')
    expect(combined).not.toContain(registryAuth)
    expect(combined).not.toContain(envSecret)
  })
})

test('create sends the requested reserved pool to exe.dev', async () => {
  let body = ''
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body)
    return Response.json({ vm_name: 'vm-1', ssh_dest: 'vm-1.exe.xyz' })
  }) as typeof fetch

  const created = await new ExeClient({ token: 'exe-token' }).create({ pool: 'pool-duet' })

  expect(body).toBe('new --pool pool-duet --no-email --json')
  expect(created).toEqual({ vm_name: 'vm-1', ssh_dest: 'vm-1.exe.xyz' })
})

test('a stalled lobby response body ends at the SDK command deadline', async () => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  const clock = spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(25))
  let timer: ReturnType<typeof setTimeout> | undefined
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{"vms":[]}'))
              controller.close()
            }, 150)
          },
          cancel() {
            clearTimeout(timer)
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    },
  })
  globalThis.fetch = ((_, init) => originalFetch(server.url, init)) as typeof fetch
  try {
    await expect(new ExeClient({ token: 'fixture-token' }).list()).rejects.toMatchObject({
      name: 'TimeoutError',
    })
  } finally {
    clearTimeout(timer)
    server.stop(true)
    clock.mockRestore()
  }
})

test('an established SSH lobby command ends at the same finite SDK deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'exe-lobby-timeout-'))
  const executable = join(directory, 'ssh')
  await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 0.2\n')
  await chmod(executable, 0o755)
  const path = process.env.PATH
  process.env.PATH = `${directory}:${path}`
  const realTimeout = globalThis.setTimeout
  const clock = spyOn(globalThis, 'setTimeout').mockImplementation(
    Object.assign((...parameters: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...args] = parameters
      return realTimeout(callback, delay ? Math.min(delay, 25) : delay, ...args)
    }, realTimeout),
  )
  try {
    await expect(new ExeClient({ host: 'fixture.invalid' }).list()).rejects.toThrow(
      'exe.dev command failed',
    )
  } finally {
    clock.mockRestore()
    process.env.PATH = path
    await rm(directory, { recursive: true, force: true })
  }
})

test('cold create may outlast ordinary lobby commands but still ends at a finite deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'exe-cold-create-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const executable = join(directory, 'ssh')
    await writeFile(
      executable,
      `#!${process.execPath}
await Bun.sleep(process.argv.some(arg => arg.includes('stalled')) ? 1500 : 400)
console.log(JSON.stringify({ vm_name: 'cold', ssh_dest: 'cold.exe.xyz' }))
`,
    )
    await chmod(executable, 0o755)
    const probe = join(directory, 'probe.test.ts')
    // Keep real command timing independent of HTTP/clock fixtures in this test runner.
    await writeFile(
      probe,
      `
      import assert from 'node:assert/strict'
      import { test, spyOn } from 'bun:test'
      import { ExeClient } from ${JSON.stringify(fileURLToPath(new URL('./exe.ts', import.meta.url)))}
      test('isolated delayed create', async () => {
      const realTimeout = globalThis.setTimeout
      const deadlines: number[] = []
      const clock = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign((callback, delay, ...args) => {
        if (delay) deadlines.push(delay)
        // Preserve the real distinction between create and ordinary command
        // budgets, while controlling elapsed time independently of their values.
        const boundedDelay = delay ? (delay === deadlines[0] ? 1000 : 20) : delay
        return realTimeout(callback, boundedDelay, ...args)
      }, realTimeout))
      try {
      const client = new ExeClient({ host: 'fixture.invalid' })
      const created = await client.create({ name: 'cold' })
      await assert.rejects(client.list(), /exe.dev command failed/)
      await assert.rejects(client.remove('cold'), /exe.dev command failed/)
      await assert.rejects(client.create({ name: 'stalled' }), /exe.dev command failed/)
      assert.ok(deadlines.some(deadline => deadline < deadlines[0]), 'cold creation needs a longer command budget')
      console.log('EXE_COLD_CREATE_RESULT ' + JSON.stringify({ created, ordinaryCommandsTimedOut: true, stalledCreateTimedOut: true }))
      } finally { clock.mockRestore() }
      }, 15_000)
    `,
    )
    const processFixture = Bun.spawn([process.execPath, 'test', probe], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    child = processFixture
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processFixture.stdout).text(),
      new Response(processFixture.stderr).text(),
      processFixture.exited,
    ])
    if (exitCode !== 0) throw new Error(stderr)
    expect(exitCode).toBe(0)
    const marker = 'EXE_COLD_CREATE_RESULT '
    const results = stdout.split('\n').filter(line => line.startsWith(marker))
    expect(results).toHaveLength(1)
    expect(JSON.parse(results[0]!.slice(marker.length))).toEqual({
      created: { vm_name: 'cold', ssh_dest: 'cold.exe.xyz' },
      ordinaryCommandsTimedOut: true,
      stalledCreateTimedOut: true,
    })
  } finally {
    if (child?.exitCode === null) child.kill()
    await child?.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
