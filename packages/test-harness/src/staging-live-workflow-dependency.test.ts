import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowDependency } from './fixtures/workflow/dependency.ts'

test('release evidence reads actual git objects and preserves unrelated file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-evidence-'))
  try {
    await writeFile(join(root, 'search.ts'), 'export const search = "broken"')
    await writeFile(join(root, 'provider.ts'), 'export const provider = "fake"')
    await writeFile(join(root, 'display.ts'), 'untouched')
    const dependency = createWorkflowDependency({
      root,
      unchangedPaths: ['display.ts'],
      provider: {
        calls: [],
        fetch: async () => Response.json({ ids: [] }),
      },
    })
    expect((await dependency(new Request('http://fixture/init', { method: 'POST' }))).status).toBe(
      200,
    )
    const author = Bun.spawn(['git', '-C', root, 'config', '--local', 'user.name'], {
      stdout: 'pipe',
    })
    expect((await new Response(author.stdout).text()).trim()).toBe('Workflow Fixture')
    expect(await author.exited).toBe(0)
    await writeFile(join(root, 'search.ts'), 'export const search = "fixed"')
    const git = Bun.spawn(
      [
        'git',
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-am',
        'implement',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await git.exited).toBe(0)
    const sha = (
      await new Response(
        Bun.spawn(['git', '-C', root, 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout,
      ).text()
    ).trim()
    await mkdir(join(root, 'release'))
    await writeFile(join(root, 'release/commit.txt'), sha)
    await writeFile(join(root, 'release/search.ts'), await readFile(join(root, 'search.ts')))
    await writeFile(join(root, 'release/provider.ts'), await readFile(join(root, 'provider.ts')))
    const response = await dependency(new Request('http://fixture/evidence'))
    const evidence = await response.json()
    expect(evidence.commitSha).toBe(sha)
    expect(evidence.recordedSha).toBe(sha)
    expect(evidence.committedSource).toBe(
      JSON.stringify({
        search: 'export const search = "fixed"',
        provider: 'export const provider = "fake"',
      }),
    )
    expect(evidence.releasedSource).toBe(evidence.committedSource)
    expect(evidence.unchangedFiles).toEqual([{ path: 'display.ts', after: 'untouched' }])
    await writeFile(join(root, 'release/commit.txt'), 'not-a-real-commit')
    expect(
      (await (await dependency(new Request('http://fixture/evidence'))).json()).commitSha,
    ).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
