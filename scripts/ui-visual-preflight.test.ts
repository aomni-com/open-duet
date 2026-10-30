import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('visual preflight', () => {
  test('approval validates the official-app ledger before capture, not the old PNG inventory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-visual-preflight-'))
    temporaryDirectories.push(directory)
    const log = path.join(directory, 'commands.log')
    for (const command of ['bun', 'bunx', 'rm']) {
      const executable = path.join(directory, command)
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' \"${command} $*\" >> \"$COMMAND_LOG\"\n`,
      )
      await chmod(executable, 0o755)
    }

    const child = Bun.spawn(
      [
        'bash',
        'scripts/ui-visual-preflight.sh',
        '--approval',
        '--filter=@repo/official-agents-seed',
      ],
      {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COMMAND_LOG: log },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await child.exited).toBe(0)
    const commands = await readFile(log, 'utf8')
    expect(commands).toContain('bun --cwd=packages/official-agents-seed run visual:coverage:write')
    expect(commands).not.toContain(
      'bun --cwd=packages/official-agents-seed run verify:visual-coverage',
    )
    expect(commands).not.toContain('bun visual:union')
    expect(commands).not.toContain('--approval')
  })

  test('approval regenerates and verifies the visual owner index after capture', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-visual-approval-'))
    temporaryDirectories.push(directory)
    const log = path.join(directory, 'docker.log')
    const docker = path.join(directory, 'docker')
    await writeFile(docker, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$COMMAND_LOG"\n')
    await chmod(docker, 0o755)

    const child = Bun.spawn(['bash', 'scripts/ui-playground.sh', 'approve', '--official-apps'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COMMAND_LOG: log },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await child.exited).toBe(0)
    const command = await readFile(log, 'utf8')
    expect(command).toContain('bun visual:union:write && bun visual:union')
    expect(command.indexOf('turbo run visual:approve')).toBeLessThan(
      command.indexOf('bun visual:union:write'),
    )
  })
})
