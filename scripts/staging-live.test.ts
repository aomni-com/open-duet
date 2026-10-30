import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the Docker staging runner forwards closeout receipts and Linux sync bytes through its existing mount', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'duet-staging-runner-'))
  try {
    const bin = join(scratch, 'bin')
    await mkdir(bin)
    await mkdir(join(scratch, 'artifacts'))
    await writeFile(join(scratch, 'artifacts/closeout.json'), '{}')
    await writeFile(join(bin, 'syncthing-linux'), 'fixture')
    const capture = join(scratch, 'captured.json')
    const docker = join(bin, 'docker')
    await writeFile(
      docker,
      `#!${process.execPath}\nawait Bun.write(process.env.E2E_DOCKER_CAPTURE, JSON.stringify({ args: process.argv.slice(2), evidence: process.env.DUET_E2E_UNIFIED_EVIDENCE, syncthing: process.env.DUET_SYNCTHING_BIN }));\n`,
    )
    await chmod(docker, 0o755)
    const processResult = Bun.spawn(
      ['bash', new URL('./staging-live.sh', import.meta.url).pathname, '--journey', 'unified-duet'],
      {
        cwd: scratch,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          E2E_DOCKER_CAPTURE: capture,
          DUET_E2E_UNIFIED_EVIDENCE: 'artifacts/closeout.json',
          DUET_SYNCTHING_BIN: join(scratch, 'bin/syncthing-linux'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await processResult.exited).toBe(0)
    const captured = JSON.parse(await readFile(capture, 'utf8')) as {
      args: string[]
      evidence: string
      syncthing: string
    }
    expect(captured.evidence).toBe('/work/artifacts/closeout.json')
    expect(captured.syncthing).toBe('/work/bin/syncthing-linux')
    expect(captured.args).toContain('DUET_E2E_UNIFIED_EVIDENCE')
    expect(captured.args).toContain('DUET_SYNCTHING_BIN')
    expect(captured.args.slice(-2)).toEqual(['--journey', 'unified-duet'])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
