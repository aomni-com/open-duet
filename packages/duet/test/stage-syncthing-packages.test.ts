import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('stock staging rejects the obsolete publish flag before acquiring binaries', async () => {
  const proc = Bun.spawn(
    ['bun', resolve(import.meta.dir, '../scripts/stage-syncthing-packages.ts'), '--publish'],
    {
      env: {
        PATH: process.env.PATH!,
        SYNCTHING_STAGE_DARWIN_ARM64: '/missing-staging-fixture/syncthing',
        SYNCTHING_STAGE_DARWIN_X64: '/missing-staging-fixture/syncthing',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code).not.toBe(0)
  expect(stdout + stderr).toContain('Stock staging accepts no arguments; it does not publish')
  expect(stdout + stderr).not.toContain('staging darwin-')
})
