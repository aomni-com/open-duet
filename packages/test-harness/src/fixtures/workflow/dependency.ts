import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { UnchangedFile, verifyReleaseOutcome } from '@repo/agent/workflow-fixtures'

export type WorkflowDiskEvidence = Omit<
  Parameters<typeof verifyReleaseOutcome>[0],
  'behaviorFailures' | 'correctionPersisted' | 'unchangedFiles'
> & { unchangedFiles: Array<Omit<UnchangedFile, 'before'>> }

/** Disposable provider dependency, outside the agent-editable task repository. */
export function createWorkflowDependency(args: {
  root: string
  unchangedPaths: readonly string[]
  provider: { calls: unknown[]; fetch: (request: Request) => Promise<Response> }
}): (request: Request) => Promise<Response> {
  let initialized = false
  async function git(...command: string[]): Promise<string | null> {
    const child = Bun.spawn(['git', '-C', args.root, ...command], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return code === 0 ? stdout : null
  }
  async function file(path: string): Promise<string | null> {
    return await readFile(join(args.root, path), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  }
  return async request => {
    const pathname = new URL(request.url).pathname
    if (pathname === '/')
      return new Response(
        '<!doctype html><title>Workflow dependency</title><body>Workflow dependency ready</body>',
        { headers: { 'content-type': 'text/html' } },
      )
    if (pathname === '/init' && request.method === 'POST') {
      if (initialized || (await file('.git/HEAD')) !== null)
        return new Response('Already initialized', { status: 409 })
      for (const command of [
        ['init'],
        ['config', 'user.name', 'Workflow Fixture'],
        ['config', 'user.email', 'fixture@example.test'],
        ['add', '.'],
        ['commit', '-m', 'initial fixture'],
      ]) {
        if ((await git(...command)) === null)
          return new Response('Git fixture initialization failed', { status: 500 })
      }
      initialized = true
      return Response.json({ initialized: true })
    }
    if (pathname === '/calls') return Response.json(args.provider.calls)
    if (pathname === '/evidence') {
      const recordedSha = (await file('release/commit.txt'))?.trim() ?? ''
      const commitSha = /^[a-f0-9]{40}$/.test(recordedSha)
        ? ((await git('rev-parse', '--verify', `${recordedSha}^{commit}`))?.trim() ?? null)
        : null
      const committedSearch = commitSha ? await git('show', `${commitSha}:search.ts`) : null
      const committedProvider = commitSha ? await git('show', `${commitSha}:provider.ts`) : null
      const releasedSearch = await file('release/search.ts')
      const releasedProvider = await file('release/provider.ts')
      const evidence: WorkflowDiskEvidence = {
        recordedSha,
        commitSha,
        committedSource:
          committedSearch === null || committedProvider === null
            ? null
            : JSON.stringify({ search: committedSearch, provider: committedProvider }),
        releasedSource:
          releasedSearch === null || releasedProvider === null
            ? null
            : JSON.stringify({ search: releasedSearch, provider: releasedProvider }),
        unchangedFiles: await Promise.all(
          args.unchangedPaths.map(async path => ({ path, after: await file(path) })),
        ),
      }
      return Response.json(evidence)
    }
    if (request.method !== 'POST') return new Response(null, { status: 204 })
    return await args.provider.fetch(request)
  }
}
