import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { convexDev, saveDashboardToSharedCache } from './convex-dev.ts'
import type { ConvexDevFixture } from './convex-dev.ts'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/convex-local')

// Timeouts are sized for a SATURATED machine, not an idle one. These spin real
// local Convex deployments — the isolation test starts TWO at once — and a full
// `bun run test` has apps/api and packages/backend spinning their own at the
// same time. At 180s this test died at 180002ms in three separate full runs and
// passed every time in isolation, which is contention, not a defect. The
// assertions are unchanged; only the budget is.
describe('convexDev', () => {
  test('isolates concurrent deployments for the same project directory', async () => {
    const deployments: ConvexDevFixture[] = []
    const failures: unknown[] = []
    try {
      // Settle both starts before propagating failure so a late successful
      // sibling is still registered for cleanup.
      const starts = await Promise.allSettled([convexDev(FIXTURE_DIR), convexDev(FIXTURE_DIR)])
      for (const result of starts) {
        if (result.status === 'fulfilled') deployments.push(result.value)
      }
      for (const result of starts) {
        if (result.status === 'rejected') throw result.reason
      }
      const [first, second] = deployments as [ConvexDevFixture, ConvexDevFixture]

      expect(first.url).not.toBe(second.url)
      expect(first.siteUrl).not.toBe(second.siteUrl)

      const [firstResult, secondResult] = await Promise.all([
        first.query('hello:echo', { value: 'first deployment' }),
        second.query('hello:echo', { value: 'second deployment' }),
      ])
      expect(firstResult).toBe('first deployment')
      expect(secondResult).toBe('second deployment')
    } catch (error) {
      failures.push(error)
    } finally {
      const stops = await Promise.allSettled(deployments.map(deployment => deployment.stop()))
      for (const result of stops) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Fixture isolation failed')
  }, 300_000)

  test('stops the local deployment when its fixture runner is killed', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'convex-dev-parent-death-'))
    const runner = spawn(
      process.execPath,
      [
        '-e',
        `
          import { convexDev } from ${JSON.stringify(
            pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'convex-dev.ts')).href,
          )}
          const fixture = await convexDev(${JSON.stringify(FIXTURE_DIR)}, {
            tmpDir: ${JSON.stringify(tempRoot)},
          })
          await fixture.query('hello:greeting')
          console.log(JSON.stringify({ url: fixture.url }))
          await new Promise(() => {})
        `,
      ],
      {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    try {
      const url = await readRunnerUrl(runner)
      expect(await isReachable(url)).toBe(true)

      runner.kill('SIGKILL')
      await waitForExit(runner)

      expect(await waitUntilUnreachable(url)).toBe(true)
    } finally {
      if (process.platform !== 'win32' && runner.pid !== undefined) {
        try {
          process.kill(-runner.pid, 'SIGKILL')
        } catch {}
      } else {
        runner.kill('SIGKILL')
      }
      await waitForExit(runner)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 300_000)
})

function readRunnerUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolveUrl, rejectUrl) => {
    let stdout = ''
    let stderr = ''
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const fail = (error: Error) => {
      cleanup()
      rejectUrl(error)
    }
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const parsed = JSON.parse(line) as { url?: unknown }
          if (typeof parsed.url !== 'string') continue
          cleanup()
          resolveUrl(parsed.url)
          return
        } catch {}
      }
    }
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    }
    const onError = (error: Error) => fail(error)
    const onExit = (code: number | null, signal: string | null) => {
      fail(
        new Error(
          `Fixture runner exited before becoming ready (code ${code}, signal ${signal}).\n${stdout}${stderr}`,
        ),
      )
    }
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for fixture runner.\n${stdout}${stderr}`))
    }, 300_000)
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit()
      return
    }
    child.once('exit', () => resolveExit())
  })
}

async function waitUntilUnreachable(url: string): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await isReachable(url))) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function isReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

// The shared dashboard cache is what lets a fresh boot skip the GitHub download.
// A populated cache of the WRONG vintage is worse than an empty one: every boot
// copies it in, the CLI sees the version mismatch, and re-downloads anyway —
// which is exactly the fetch that fails when GitHub is unreachable. The 08-05
// bundle sat in the shared cache for a month after the 08-25 binary arrived.
describe('shared dashboard cache', () => {
  function bundle(root: string, version: string): string {
    const dir = join(root, '.cache', 'convex', 'dashboard')
    mkdirSync(join(dir, 'out'), { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ version }))
    writeFileSync(join(dir, 'out', 'index.html'), version)
    return dir
  }

  test('a downloaded bundle of a newer vintage replaces the shared one', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-dashboard-cache-'))
    try {
      const shared = bundle(join(root, 'shared'), 'precompiled-2026-08-05-38abb46')
      const home = join(root, 'home')
      bundle(home, 'precompiled-2026-08-25-7cce8fb')
      saveDashboardToSharedCache(home, shared)
      expect(JSON.parse(readFileSync(join(shared, 'config.json'), 'utf8'))).toEqual({
        version: 'precompiled-2026-08-25-7cce8fb',
      })
      expect(readFileSync(join(shared, 'out', 'index.html'), 'utf8')).toBe(
        'precompiled-2026-08-25-7cce8fb',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a downloaded bundle of the same vintage leaves the shared one alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-dashboard-cache-'))
    try {
      const shared = bundle(join(root, 'shared'), 'precompiled-2026-08-25-7cce8fb')
      writeFileSync(join(shared, 'out', 'index.html'), 'the shared copy')
      const home = join(root, 'home')
      bundle(home, 'precompiled-2026-08-25-7cce8fb')
      saveDashboardToSharedCache(home, shared)
      expect(readFileSync(join(shared, 'out', 'index.html'), 'utf8')).toBe('the shared copy')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
