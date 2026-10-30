import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Hono } from 'hono'

import { INTERNAL_ADMIN_MAX_FILE_BYTES, REDACTION_MASK } from '@repo/contract'

import { createInternalAdminRoutes } from './internalAdmin'

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('gateway internal admin boundary', () => {
  test('returns a typed busy refusal from the Chrome update rail', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-chrome-update-'))
    const app = createInternalAdminRoutes({
      driveDir: root,
      stateDir: stateRoot(root),
      updateChrome: async () => ({ ok: false as const, error: 'desktop_busy' as const }),
    })

    const response = await app.request('/chrome-update', { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'desktop_busy' })
  })

  test('returns structured runtime status through the protected admin route', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-status-'))
    const app = createInternalAdminRoutes({
      driveDir: root,
      stateDir: stateRoot(root),
      status: () => ({ runtimeVersion: 'gw-test', uptimeSeconds: 42 }),
    })
    expect(await (await app.request('/status')).json()).toEqual({
      runtimeVersion: 'gw-test',
      uptimeSeconds: 42,
    })
  })

  test('bounds filesystem paths, listing size, file bytes, and redacts secrets', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-gateway-'))
    await mkdir(join(root, 'projects'))
    const secret = `duet_sk_${'a'.repeat(64)}`
    await writeFile(
      join(root, 'projects', 'secret.txt'),
      `API_KEY=${secret}\n${'x'.repeat(INTERNAL_ADMIN_MAX_FILE_BYTES)}`,
    )
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    const traversal = await app.request('/files?path=../../etc')
    expect(traversal.status).toBe(400)
    const list = await app.request('/files?path=projects')
    expect(await list.json()).toMatchObject({
      path: 'projects',
      truncated: false,
      entries: [{ name: 'secret.txt', kind: 'file' }],
    })
    const file = await app.request('/file?path=projects/secret.txt')
    const body = (await file.json()) as { content: string; truncated: boolean; byteLength: number }
    expect(body.content).toContain(REDACTION_MASK)
    expect(body.content).not.toContain(secret)
    expect(body.truncated).toBe(true)
    expect(body.byteLength).toBeGreaterThan(INTERNAL_ADMIN_MAX_FILE_BYTES)

    await symlink(tmpdir(), join(root, 'outside'))
    const symlinkTraversal = await app.request('/files?path=outside')
    expect(symlinkTraversal.status).toBe(400)
    const rootList = await app.request('/files')
    expect(JSON.stringify(await rootList.json())).not.toContain('outside')
  })

  test('accepts only the explicit argv allowlist and never invokes a shell expression', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-command-'))
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })
    const denied = await app.request('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pwd; rm -rf /' }),
    })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toEqual({ error: 'command_not_allowed' })
    const allowed = await app.request('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pwd' }),
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ command: 'pwd', exitCode: 0, truncated: false })
  })

  test('does not let skipped symlinks consume the visible directory limit', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-list-limit-'))
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        writeFile(join(root!, `file-${String(index).padStart(3, '0')}.txt`), 'visible'),
      ),
    )
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        symlink(tmpdir(), join(root!, `00-link-${String(index).padStart(2, '0')}`)),
      ),
    )
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })
    const response = await app.request('/files')
    const body = (await response.json()) as { entries: unknown[]; truncated: boolean }
    expect(body.entries).toHaveLength(200)
    expect(body.truncated).toBe(true)
  })

  test('turns a bounded command timeout into a stable upstream response', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-timeout-'))
    const app = createInternalAdminRoutes({
      driveDir: root,
      stateDir: stateRoot(root),
      runCommand: async () => {
        const error = new Error('timed out') as Error & { killed: boolean }
        error.killed = true
        throw error
      },
    })
    const response = await app.request('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'uptime' }),
    })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'command_timeout' })
  })

  test('returns bounded partial output when an allowed command exceeds the process buffer', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-admin-buffer-'))
    const app = createInternalAdminRoutes({
      driveDir: root,
      stateDir: stateRoot(root),
      runCommand: async () => {
        const error = new Error('stdout maxBuffer length exceeded') as Error & {
          code: string
          stdout: string
          stderr: string
        }
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        error.stdout = 'partial status output\n'
        error.stderr = ''
        throw error
      },
    })
    const response = await app.request('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'git status --short' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      stdout: 'partial status output\n',
      exitCode: 0,
      truncated: true,
    })
  })
})

// In a real VM the state dir sits outside the drive; these fixtures mirror that
// so a test can never accidentally prove drive containment reaches a log.
function stateRoot(driveDir: string): string {
  return join(driveDir, '..', '.duet-state')
}

describe('internal admin logs', () => {
  let drive: string
  let state: string

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'duet-admin-logs-'))
    drive = join(base, 'drive')
    state = join(base, '.duet-state')
    await mkdir(join(state, 'logs'), { recursive: true })
    await mkdir(join(state, 'agents', 'anchor_a'), { recursive: true })
    await mkdir(drive, { recursive: true })
    await writeFile(join(state, 'logs', 'gateway.log'), '{"label":"boot"}\n')
    await writeFile(join(state, 'logs.log'), 'root agent line\n')
    await writeFile(join(state, 'agents', 'anchor_a', 'logs.log'), 'anchor a line\n')
    // A credential file living beside the logs, exactly as it does in a VM.
    await writeFile(join(state, 'model-credentials.json'), '{"apiKey":"sk-live-DO-NOT-SERVE"}')
  })

  test('serves both log families and enumerates what else is readable', async () => {
    const app = createInternalAdminRoutes({ driveDir: drive, stateDir: state })

    const gateway = (await (await app.request('/logs')).json()) as {
      source: string
      content: string
      available: Array<{ source: string; anchorId?: string; byteLength: number }>
    }
    expect(gateway.source).toBe('gateway')
    expect(gateway.content).toContain('boot')
    expect(gateway.available).toEqual([
      { source: 'gateway', byteLength: 17 },
      { source: 'agent', byteLength: 16 },
      { source: 'agent', anchorId: 'anchor_a', byteLength: 14 },
    ])

    const rootAgent = (await (await app.request('/logs?source=agent')).json()) as {
      content: string
    }
    expect(rootAgent.content).toContain('root agent line')

    const anchored = (await (await app.request('/logs?source=agent&anchorId=anchor_a')).json()) as {
      content: string
      anchorId: string
    }
    expect(anchored.anchorId).toBe('anchor_a')
    expect(anchored.content).toContain('anchor a line')
  })

  test('the enumerated sources are the only reachable files, so credentials stay put', async () => {
    const app = createInternalAdminRoutes({ driveDir: drive, stateDir: state })

    // These responses are deliberately unredacted, so the containment IS the
    // source enum. Anything that lets a caller name a path serves the
    // credential store sitting in the same directory.
    for (const query of [
      '?source=model-credentials.json',
      '?source=agent&anchorId=..',
      '?source=agent&anchorId=../..',
      '?source=agent&anchorId=a/../../logs',
    ]) {
      const response = await app.request(`/logs${query}`)
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain('sk-live-DO-NOT-SERVE')
    }
  })

  test('returns the newest bytes, because logs are capped from the front', async () => {
    const app = createInternalAdminRoutes({ driveDir: drive, stateDir: state })
    const oldest = 'A'.repeat(INTERNAL_ADMIN_MAX_FILE_BYTES)
    await writeFile(join(state, 'logs', 'gateway.log'), `${oldest}NEWEST_LINE\n`)

    const body = (await (await app.request('/logs')).json()) as {
      content: string
      truncated: boolean
      byteLength: number
    }
    expect(body.content).toContain('NEWEST_LINE')
    expect(body.content.startsWith('A'.repeat(64))).toBe(true)
    expect(body.truncated).toBe(true)
    expect(body.byteLength).toBe(oldest.length + 'NEWEST_LINE\n'.length)
  })

  test('a missing log is a 404 that still says what exists', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'duet-admin-logs-bare-'))
    const app = createInternalAdminRoutes({ driveDir: bare, stateDir: join(bare, 'state') })
    const response = await app.request('/logs')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found', available: [] })
  })
})

describe('converge subtree', () => {
  const converge = (app: Hono, body: unknown) =>
    app.request('/converge-subtree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const file = (path: string, text: string) => ({
    path,
    base64: Buffer.from(text).toString('base64'),
  })

  test('writes what differs, leaves identical bytes untouched, and reaps what the plan dropped', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-converge-'))
    await mkdir(join(root, 'agents', 'alpha', 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(root, 'agents', 'alpha', 'AGENTS.md'), 'same')
    await writeFile(join(root, 'agents', 'alpha', 'stale.md'), 'only on disk')
    await writeFile(join(root, 'agents', 'alpha', 'node_modules', 'dep', 'index.js'), 'installed')
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    const before = await stat(join(root, 'agents', 'alpha', 'AGENTS.md'))
    const response = await converge(app, {
      roots: ['agents/alpha'],
      files: [
        file('agents/alpha/AGENTS.md', 'same'),
        file('agents/alpha/CHANGELOG.md', 'new file'),
      ],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      written: ['agents/alpha/CHANGELOG.md'],
      unchanged: 1,
      deleted: ['agents/alpha/stale.md'],
    })
    // The mtime is the contract: the publish ETag is derived from it, so an
    // identical rewrite would badge every subscriber with a phantom update.
    // This is why the reap is a diff and not a wipe-and-rewrite.
    expect((await stat(join(root, 'agents', 'alpha', 'AGENTS.md'))).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(join(root, 'agents', 'alpha', 'CHANGELOG.md'), 'utf8')).toBe('new file')
    // Under a managed root the repo is the whole truth, so a path the plan no
    // longer claims goes — that is what makes a rename or a deletion in the
    // repo reach the hub at all.
    expect(existsSync(join(root, 'agents', 'alpha', 'stale.md'))).toBe(false)
    // The floor is never reaped: an installed dependency tree is not ours to
    // delete, and `.duet-anchor` is the marker whose loss makes the gateway
    // refuse to serve the folder as a hijack.
    expect(
      await readFile(join(root, 'agents', 'alpha', 'node_modules', 'dep', 'index.js'), 'utf8'),
    ).toBe('installed')
  })

  test('reaps a renamed directory and keeps the anchor marker that names the folder', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-converge-rename-'))
    const skills = join(root, 'agents', 'alpha', '.agents', 'skills')
    await mkdir(join(skills, 'explore-unknowns', 'references'), { recursive: true })
    await writeFile(join(skills, 'explore-unknowns', 'SKILL.md'), 'old name')
    await writeFile(join(skills, 'explore-unknowns', 'references', 'stage-1.md'), 'nested')
    await writeFile(join(root, 'agents', 'alpha', '.duet-anchor'), 'marker')
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    const response = await converge(app, {
      roots: ['agents/alpha'],
      files: [file('agents/alpha/.agents/skills/what-to-build/SKILL.md', 'old name')],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { deleted: string[] }
    expect(body.deleted.sort()).toEqual([
      'agents/alpha/.agents/skills/explore-unknowns/SKILL.md',
      'agents/alpha/.agents/skills/explore-unknowns/references/stage-1.md',
    ])
    // The husk goes too, or a rename leaves an empty directory behind forever.
    expect(existsSync(join(skills, 'explore-unknowns'))).toBe(false)
    expect(await readFile(join(skills, 'what-to-build', 'SKILL.md'), 'utf8')).toBe('old name')
    expect(await readFile(join(root, 'agents', 'alpha', '.duet-anchor'), 'utf8')).toBe('marker')
  })

  test('a root the plan does not name is untouched, because demotion is not deletion', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-converge-demoted-'))
    await mkdir(join(root, 'agents', 'demoted'), { recursive: true })
    await mkdir(join(root, 'agents', 'alpha'), { recursive: true })
    await writeFile(join(root, 'agents', 'demoted', 'AGENTS.md'), 'handed back to the hub')
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    const response = await converge(app, {
      roots: ['agents/alpha'],
      files: [file('agents/alpha/AGENTS.md', 'managed')],
    })

    expect(response.status).toBe(200)
    expect((await response.json()).deleted).toEqual([])
    expect(await readFile(join(root, 'agents', 'demoted', 'AGENTS.md'), 'utf8')).toBe(
      'handed back to the hub',
    )
  })

  test('changed bytes are written', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-converge-changed-'))
    await mkdir(join(root, 'agents', 'alpha'), { recursive: true })
    await writeFile(join(root, 'agents', 'alpha', 'AGENTS.md'), 'old')
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    const response = await converge(app, {
      roots: ['agents/alpha'],
      files: [file('agents/alpha/AGENTS.md', 'new')],
    })

    expect(await response.json()).toEqual({
      written: ['agents/alpha/AGENTS.md'],
      unchanged: 0,
      deleted: [],
    })
    expect(await readFile(join(root, 'agents', 'alpha', 'AGENTS.md'), 'utf8')).toBe('new')
  })

  test('a path outside the roots fails the whole request without writing anything', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-converge-scope-'))
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    const response = await converge(app, {
      roots: ['agents/alpha'],
      files: [
        file('agents/alpha/AGENTS.md', 'in scope'),
        // Shares a string prefix with the root but is a different folder.
        file('agents/alpha-extra/AGENTS.md', 'out of scope'),
      ],
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'path_outside_roots' })
    // Half-applying a buggy caller's intent is worse than applying none of it.
    expect(existsSync(join(root, 'agents', 'alpha', 'AGENTS.md'))).toBe(false)
  })

  test('traversal is refused and a symlinked target is never written through', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-converge-links-'))
    await mkdir(join(root, 'agents', 'alpha'), { recursive: true })
    await writeFile(join(root, 'outside.md'), 'untouched')
    await symlink(join(root, 'outside.md'), join(root, 'agents', 'alpha', 'link.md'))
    const app = createInternalAdminRoutes({ driveDir: root, stateDir: stateRoot(root) })

    expect(
      (
        await converge(app, {
          roots: ['agents/alpha'],
          files: [file('agents/alpha/../../escape.md', 'nope')],
        })
      ).status,
    ).toBe(400)

    const link = await converge(app, {
      roots: ['agents/alpha'],
      files: [file('agents/alpha/link.md', 'through the link')],
    })
    expect(link.status).toBe(409)
    expect(await link.json()).toMatchObject({ error: 'path_is_symlink' })
    expect(await readFile(join(root, 'outside.md'), 'utf8')).toBe('untouched')
  })
})
