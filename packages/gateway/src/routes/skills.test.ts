import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import { createSkillsRoutes } from './skills'

let tempDir: string
let driveDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-skills-'))
  driveDir = join(tempDir, 'drive')
  await mkdir(join(driveDir, 'agents', 'scout'), { recursive: true })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function mountApp(
  runner: (argv: string[]) => Promise<{ exitCode: number; stdout: string; timedOut?: boolean }>,
): {
  app: Hono
  calls: string[][]
} {
  const calls: string[][] = []
  const app = new Hono()
  app.route(
    '/v1/skills',
    createSkillsRoutes({
      driveDir,
      runner: async argv => {
        calls.push(argv)
        const result = await runner(argv)
        return { stderr: '', ...result }
      },
    }),
  )
  return { app, calls }
}

const CLI_OUTPUT = JSON.stringify({
  skills: [
    {
      name: 'review',
      description: 'Closeout pass on a finished change',
      path: '/home/duet/drive/agents/scout/.agents/skills/review',
      scope: 'project',
    },
  ],
  collisions: [{ name: 'review', winnerPath: '/a', loserPath: '/b' }],
})

test('asks the agent CLI about the agent folder, not the drive root', async () => {
  const { app, calls } = mountApp(async () => ({ exitCode: 0, stdout: CLI_OUTPUT }))

  const response = await app.request('/v1/skills?cwd=agents%2Fscout')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    skills: [
      {
        name: 'review',
        description: 'Closeout pass on a finished change',
        path: '/home/duet/drive/agents/scout/.agents/skills/review',
        scope: 'project',
      },
    ],
  })
  expect(calls).toEqual([['skills', '--workdir', join(driveDir, 'agents', 'scout')]])
})

test('an absent cwd asks about the drive root', async () => {
  const { app, calls } = mountApp(async () => ({ exitCode: 0, stdout: CLI_OUTPUT }))

  await app.request('/v1/skills')

  expect(calls).toEqual([['skills', '--workdir', driveDir]])
})

test('a cwd outside the drive is refused without running anything', async () => {
  const { app, calls } = mountApp(async () => ({ exitCode: 0, stdout: CLI_OUTPUT }))

  const response = await app.request('/v1/skills?cwd=..%2F..%2Fetc')

  expect(response.status).toBe(400)
  expect(calls).toEqual([])
})

test('a failed CLI answers 502 rather than an empty listing', async () => {
  const { app } = mountApp(async () => ({ exitCode: 1, stdout: '' }))

  const response = await app.request('/v1/skills')

  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: 'skills_cli_failed' })
})

test('a CLI killed at its cap answers 504, not a CLI failure', async () => {
  const { app } = mountApp(async () => ({ exitCode: 143, stdout: '', timedOut: true }))

  const response = await app.request('/v1/skills')

  expect(response.status).toBe(504)
  expect(await response.json()).toMatchObject({ error: 'skills_cli_timeout' })
})

test('unreadable CLI output answers 502 rather than an empty listing', async () => {
  const { app } = mountApp(async () => ({ exitCode: 0, stdout: 'not json' }))

  const response = await app.request('/v1/skills')

  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: 'skills_cli_invalid_json' })
})

test('a listing beyond the product cap fails instead of materializing unbounded work', async () => {
  const skills = Array.from({ length: 1_001 }, (_, index) => ({
    name: `skill-${index}`,
    path: `/skills/${index}`,
  }))
  const { app } = mountApp(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ skills }),
  }))

  const response = await app.request('/v1/skills')

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: 'skills_cli_listing_too_large' })
})
