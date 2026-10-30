import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDuetTrain } from './duet-cli-runner'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-cli-runner-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('duet train process boundary', () => {
  test('spawns synthesis once on the memory model with an explicit store and no database argument', async () => {
    const binDir = join(root, 'bin')
    const stagingDir = join(root, 'stage')
    const storeDir = join(root, 'job store')
    const capture = join(root, 'argv.jsonl')
    await Promise.all([mkdir(binDir), mkdir(stagingDir)])
    const duet = join(binDir, 'duet')
    await writeFile(
      duet,
      [
        '#!/usr/bin/env bun',
        "import { appendFile } from 'node:fs/promises'",
        "await appendFile(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n')",
      ].join('\n'),
      { mode: 0o700 },
    )
    await chmod(duet, 0o700)

    const result = await runDuetTrain({
      stagingDir,
      slug: 'store-output',
      storeDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, ARGV_CAPTURE: capture },
    })

    expect(result.record).toBeNull()
    expect(
      (await readFile(capture, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    ).toEqual([
      ['train', stagingDir, '--slug', 'store-output', '--store', storeDir, '--model', 'luna'],
    ])
    expect(await readFile(capture, 'utf8')).toContain('--store')
    expect(await readFile(capture, 'utf8')).not.toContain('--db')
  })

  test('kills the command when output exceeds the bounded buffer', async () => {
    const binDir = join(root, 'bin')
    const stagingDir = join(root, 'stage')
    const survivedMarker = join(root, 'survived')
    await Promise.all([mkdir(binDir), mkdir(stagingDir)])
    const duet = join(binDir, 'duet')
    await writeFile(
      duet,
      [
        '#!/usr/bin/env bun',
        "import { writeFile } from 'node:fs/promises'",
        "import { writeSync } from 'node:fs'",
        "writeSync(1, Buffer.alloc(13 * 1024 * 1024, 'x'))",
        'await Bun.sleep(200)',
        "await writeFile(process.env.SURVIVED_MARKER, 'alive')",
      ].join('\n'),
      { mode: 0o700 },
    )
    await chmod(duet, 0o700)

    await expect(
      runDuetTrain({
        stagingDir,
        slug: 'bounded-output',
        storeDir: join(root, 'store'),
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, SURVIVED_MARKER: survivedMarker },
      }),
    ).rejects.toThrow('output exceeded')
    await Bun.sleep(300)
    expect(await readFile(survivedMarker, 'utf8').catch(() => null)).toBeNull()
  })

  test('kills a train command that exceeds its deadline', async () => {
    const binDir = join(root, 'bin')
    const stagingDir = join(root, 'stage')
    await Promise.all([mkdir(binDir), mkdir(stagingDir)])
    const duet = join(binDir, 'duet')
    await writeFile(duet, '#!/usr/bin/env bun\nawait Bun.sleep(10_000)\n', { mode: 0o700 })
    await chmod(duet, 0o700)

    await expect(
      runDuetTrain({
        stagingDir,
        slug: 'deadline',
        storeDir: join(root, 'store'),
        commandTimeoutMs: 20,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      }),
    ).rejects.toThrow('exceeded 20ms')
  })
})
