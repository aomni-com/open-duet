import { afterEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { buildVercelOutput } from '../scripts/build-vercel-output'

let outputDirectory: string | undefined
const execFileAsync = promisify(execFile)

afterEach(async () => {
  if (outputDirectory !== undefined) await rm(outputDirectory, { recursive: true, force: true })
  outputDirectory = undefined
})

test('the bundled raw Vercel function executes without workspace module resolution', async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), 'duet-edge-vercel-'))
  await buildVercelOutput(outputDirectory)

  const entryUrl = pathToFileURL(
    path.join(outputDirectory, 'functions/api.func/vercel-entry.js'),
  ).href
  const script = [
    `const { default: app } = await import(${JSON.stringify(entryUrl)})`,
    "const request = new Request('https://app.duet.so/nope', { headers: { host: 'app.duet.so' } })",
    'console.log((await app.fetch(request)).status)',
  ].join(';')
  const { stdout } = await execFileAsync('node', ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      CONVEX_DEPLOYMENT: 'dev:fixture-deployment',
      DUET_EDGE_INTERNAL_KEY: 'fixture-edge-secret',
      // The assertion reads raw stdout, and a colour-forcing parent shell
      // (FORCE_COLOR) makes node wrap the number in ANSI codes. Pin the seam:
      // this test is about module resolution, not about the terminal.
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  })
  expect(stdout.trim()).toBe('421')
})

test('the deployed function opts into downstream request cancellation', async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), 'duet-edge-vercel-'))
  await buildVercelOutput(outputDirectory)

  const config = JSON.parse(
    await readFile(path.join(outputDirectory, 'functions/api.func/.vc-config.json'), 'utf8'),
  ) as Record<string, unknown>

  expect(config.supportsCancellation).toBeTrue()
})
