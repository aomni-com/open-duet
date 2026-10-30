import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

// Bun exits with code 1 on an unhandled rejection or an uncaught throw. The
// gateway is one process hosting every rail (sync, apps, sessions, files), so
// a stray async bug in any of them would take all of them down — and a
// deterministic one becomes a systemd crash loop. Proven on a real process,
// not on a handler registry.
test('a stray rejection or throw is logged and the gateway process stays up', () => {
  const script = `
    import { installProcessGuards } from ${JSON.stringify(resolve(import.meta.dir, 'process-guards.ts'))}
    installProcessGuards(fields => console.log(JSON.stringify(fields)))
    Promise.reject(new Error('stray rejection'))
    setTimeout(() => { throw new Error('stray throw') }, 10)
    setTimeout(() => { console.log('alive'); process.exit(0) }, 80)
  `
  const run = Bun.spawnSync(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' })

  const out = run.stdout.toString()
  expect(run.exitCode).toBe(0)
  expect(out).toContain('"operation":"unhandled_rejection"')
  expect(out).toContain('stray rejection')
  expect(out).toContain('"operation":"uncaught_exception"')
  expect(out).toContain('stray throw')
  expect(out.trim().endsWith('alive')).toBe(true)
})
