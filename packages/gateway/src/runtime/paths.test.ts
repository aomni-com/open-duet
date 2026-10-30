import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { RUNTIME_RELEASE_ARTIFACT_NAMES } from '@repo/contract'

import { resolveRuntimePaths } from './paths'

test('a running gateway keeps its physical helper and CLI when current changes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-paths-')))
  try {
    for (const name of ['old', 'new']) {
      const dir = join(root, name)
      await mkdir(dir)
      await writeFile(join(dir, 'index.js'), '// gateway\n')
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({
          formatVersion: 1,
          version: `0.0.0+${name}`,
          artifacts: RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => ({
            name,
            sha256: 'a'.repeat(64),
            byteLength: 10,
            mode: name === 'duet' ? 0o755 : 0o644,
          })),
        }),
      )
    }
    const current = join(root, 'current')
    await symlink(join(root, 'old'), current)
    const running = resolveRuntimePaths(join(current, 'index.js'))
    await unlink(current)
    await symlink(join(root, 'new'), current)
    expect(running).toEqual({
      directory: join(root, 'old'),
      version: '0.0.0+old',
      duet: join(root, 'old', 'duet'),
      helper: join(root, 'old', 'helper.js'),
    })
    expect(resolveRuntimePaths(join(current, 'index.js')).version).toBe('0.0.0+new')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the built gateway CLI seam spawns its own release after current switches', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-spawn-')))
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  try {
    const entry = join(root, 'entry.ts')
    await writeFile(
      entry,
      `
      import { spawnDuetCli } from ${JSON.stringify(resolve(import.meta.dir, '../duet-cli.ts'))};
      import { RUNNING_RUNTIME } from ${JSON.stringify(resolve(import.meta.dir, 'paths.ts'))};
      import { createConnectSessionManager } from ${JSON.stringify(resolve(import.meta.dir, '../connected-providers/connect-session.ts'))};
      console.log('ready');
      const reader = Bun.stdin.stream().getReader();
      await reader.read();
      const cli = await spawnDuetCli(['--version']);
      const nested = await spawnDuetCli(['--nested']);
      const provider = (await createConnectSessionManager({}).status())[0]?.connectedAt;
      const helper = Bun.spawn([process.execPath, RUNNING_RUNTIME.helper], {stdout:'pipe', stderr:'pipe'});
      console.log(JSON.stringify({cli:cli.stdout.trim(), nested:nested.stdout.trim(), provider, helper:(await new Response(helper.stdout).text()).trim(), helperExit:await helper.exited}));
    `,
    )
    const built = await Bun.build({ entrypoints: [entry], target: 'bun' })
    expect(built.success).toBe(true)
    for (const label of ['old', 'new']) {
      const dir = join(root, label)
      await mkdir(dir)
      await writeFile(join(dir, 'index.js'), await built.outputs[0]!.text())
      await writeFile(join(dir, 'helper.js'), `console.log('${label}')\n`)
      await writeFile(
        join(dir, 'duet'),
        `#!/bin/sh\nif [ "$1" = "--nested" ]; then exec duet --version; fi\nif [ "$1" = "connect" ]; then\n  if [ "$(duet --version)" = "old" ]; then stamp=1; else stamp=2; fi\n  echo '{"connections":[{"provider":"openai-codex","eligibility":"unknown","connectedAt":'"$stamp"'}]}'\n  exit 0\nfi\necho ${label}\n`,
        { mode: 0o755 },
      )
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({
          formatVersion: 1,
          version: `0.0.0+${label}`,
          artifacts: RUNTIME_RELEASE_ARTIFACT_NAMES.map(name => ({
            name,
            sha256: 'a'.repeat(64),
            byteLength: 10,
            mode: name === 'duet' ? 0o755 : 0o644,
          })),
        }),
      )
    }
    const current = join(root, 'current')
    await symlink(join(root, 'old'), current)
    child = Bun.spawn([process.execPath, join(current, 'index.js')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000,
      killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${current}:${process.env.PATH}` },
    })
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value).trim()).toBe('ready')
    await unlink(current)
    await symlink(join(root, 'new'), current)
    child.stdin.write('continue\n')
    child.stdin.end()
    const remainingStdout = async () => {
      let output = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return output
        output += new TextDecoder().decode(chunk.value)
      }
    }
    const [stdout, stderr, exit] = await Promise.all([
      remainingStdout(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      cli: 'old',
      nested: 'old',
      provider: 1,
      helper: 'old',
      helperExit: 0,
    })
  } finally {
    if (child) {
      child.kill()
      await child.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
