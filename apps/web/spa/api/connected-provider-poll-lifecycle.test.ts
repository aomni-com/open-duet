import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('polls through device-code readiness while hidden without refetching a terminal session', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./connected-provider-poll-lifecycle.fixture.ts', import.meta.url)),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(exitCode, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ calls: 3, status: 'connected', isError: false })
})
