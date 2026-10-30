import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { REDACTION_MASK } from './redaction'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'duet-gateway-logger-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

test('serializes Node errors and redacts their details at the log boundary', async () => {
  const secret = `duet_vm_${'a'.repeat(64)}`
  await logInChild(`
    const secret = ${JSON.stringify(secret)}
    const exception = Object.assign(new Error('link failed for ' + secret), {
      code: 'EXDEV', errno: -18, syscall: 'link', path: '/state/' + secret,
      dest: '/drive/agent', address: '127.0.0.1', port: 443,
    })
    createGatewayLogger(stateDir).log('official-agents', {
      operation: 'official_agent_pull', exception,
    })
  `)

  const rawLog = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
  const entry = JSON.parse(rawLog) as Record<string, unknown>
  expect(entry).toEqual({
    ts: expect.any(String),
    label: 'official-agents',
    operation: 'official_agent_pull',
    exception: {
      name: 'Error',
      message: `link failed for ${REDACTION_MASK}`,
      stack: expect.stringContaining(`link failed for ${REDACTION_MASK}`),
      code: 'EXDEV',
      errno: -18,
      syscall: 'link',
      path: `/state/${REDACTION_MASK}`,
      dest: '/drive/agent',
      address: '127.0.0.1',
      port: 443,
    },
  })
  expect(rawLog).not.toContain(secret)
})

test('makes a non-Error thrown value safe to log as an exception', async () => {
  await logInChild(`createGatewayLogger(stateDir).log('official-agents', {
    operation: 'official_agent_pull', exception: 18n,
  })`)

  const rawLog = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
  expect(JSON.parse(rawLog)).toEqual({
    ts: expect.any(String),
    label: 'official-agents',
    operation: 'official_agent_pull',
    exception: { name: 'NonError', message: '18' },
  })
})

async function logInChild(operation: string): Promise<void> {
  const script = `
    import { createGatewayLogger } from ${JSON.stringify(resolve(import.meta.dir, 'gateway-logger.ts'))}
    const stateDir = ${JSON.stringify(stateDir)}
    ${operation}
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 5_000,
    killSignal: 'SIGKILL',
  })
  try {
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code, stderr).toBe(0)
  } finally {
    child.kill()
    await child.exited
  }
}
