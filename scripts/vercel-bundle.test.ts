import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('the isolated MCP function can load the Node media downloader dependency', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'duet-mcp-package-'))
  try {
    await mkdir(join(scratch, 'src'))
    await writeFile(join(scratch, 'src/index.ts'), 'export default {};\n')
    await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'mcp', type: 'module' }))
    const build = Bun.spawn(['node', resolve(import.meta.dir, 'vercel-bundle.mjs')], {
      cwd: scratch,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [, stderr, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    const entry = join(scratch, '.vercel/output/functions/index.func/index.mjs')
    const probe = Bun.spawn(
      [
        'node',
        '--input-type=module',
        '-e',
        `
      import { createRequire } from 'node:module';
      const { Agent, fetch } = createRequire(${JSON.stringify(entry)})('undici');
      const agent = new Agent();
      await agent.close();
      if (typeof fetch !== 'function') throw new Error('Missing downloader');
    `,
      ],
      { cwd: scratch, stdout: 'pipe', stderr: 'pipe' },
    )
    const [probeError, probeCode] = await Promise.all([
      new Response(probe.stderr).text(),
      probe.exited,
    ])
    expect({ code: probeCode, stderr: probeError }).toEqual({ code: 0, stderr: '' })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 30_000)
