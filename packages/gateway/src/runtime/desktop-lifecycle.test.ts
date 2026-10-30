import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('the production desktop loop is explicit and idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-desktop-runtime-'))
  const script = `
    import { createGatewayRuntime } from ${JSON.stringify(resolve(import.meta.dir, 'http.ts'))}
    const calls = []
    const runtime = createGatewayRuntime({
      stateDir: ${JSON.stringify(join(root, 'state'))},
      driveDir: ${JSON.stringify(join(root, 'drive'))},
      systemCommand: async argv => { calls.push(argv); return { exitCode: 3 } },
    })
    if (calls.length) throw new Error('desktop loop started during construction')
    runtime.startDesktopLoop()
    runtime.startDesktopLoop()
    for (let wait = 0; calls.length < 2 && wait < 100; wait++) await Bun.sleep(5)
    console.log(JSON.stringify(calls))
    process.exit(0)
  `
  const child = Bun.spawn(['bun', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    // The real runtime reconciles the browser when the target is down.
    expect(JSON.parse(stdout)).toEqual([
      ['sudo', '-n', 'systemctl', 'is-active', 'duet-desktop.target'],
      ['sudo', '-n', 'systemctl', 'stop', 'duet-desktop-browser.service'],
    ])
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
})
