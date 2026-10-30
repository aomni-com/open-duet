import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a failed CLI probe persists timing and exit evidence without provider output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'model-refresh-probe-'))
  try {
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    const executable = '#!/bin/sh\nprintf "private provider output" >&2\nexit 143\n'
    await writeFile(join(bin, 'duet'), executable, { mode: 0o755 })
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/model-refresh/probe.ts'),
        JSON.stringify({
          runtimeVersion: 'fixture',
          duetArtifact: {
            sha256: createHash('sha256').update(executable).digest('hex'),
            byteLength: Buffer.byteLength(executable),
            mode: 0o755,
          },
          roles: {},
          skillHash: 'fixture',
        }),
      ],
      {
        cwd,
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    const contents = await readFile(join(cwd, 'model-refresh-receipt.json'), 'utf8')
    const receipt = JSON.parse(contents)
    expect(receipt.status).toBe('failed')
    expect(receipt.commands).toEqual([
      expect.objectContaining({ command: 'skills', exitCode: 143, status: 'failed' }),
    ])
    expect(receipt.commands[0].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(receipt.commands[0].timeoutMs).toBeGreaterThan(0)
    expect(contents).not.toContain('private provider output')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('installed CLI hash mismatch refuses every CLI or provider command', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'model-refresh-hash-'))
  try {
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    const executable = '#!/bin/sh\nprintf ran > would-run\nexit 143\n'
    await writeFile(join(bin, 'duet'), executable, { mode: 0o755 })
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/model-refresh/probe.ts'),
        JSON.stringify({
          runtimeVersion: 'fixture',
          duetArtifact: {
            sha256: '0'.repeat(64),
            byteLength: Buffer.byteLength(executable),
            mode: 0o755,
          },
          roles: {},
          skillHash: 'fixture',
        }),
      ],
      {
        cwd,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      },
    )
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    const receipt = JSON.parse(await readFile(join(cwd, 'model-refresh-receipt.json'), 'utf8'))
    expect(receipt.error).toContain('installed CLI bytes differ')
    expect(
      JSON.parse(await readFile(join(cwd, 'model-refresh-receipt.json'), 'utf8')),
    ).toMatchObject({ status: 'failed', commands: [] })
    await expect(readFile(join(cwd, 'would-run'))).rejects.toThrow()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
