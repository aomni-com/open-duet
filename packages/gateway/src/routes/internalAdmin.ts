import { execFile } from 'node:child_process'
import { lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { Hono } from 'hono'

import {
  GatewayConvergeSubtreeRequestSchema,
  normalizeDrivePath,
  isPublishExcludedDrivePath,
  MAX_RECURSIVE_FILE_ENTRIES,
  INTERNAL_ADMIN_COMMAND_TIMEOUT_MS,
  INTERNAL_ADMIN_MAX_COMMAND_OUTPUT_BYTES,
  INTERNAL_ADMIN_MAX_FILE_BYTES,
} from '@repo/contract'

import type { ChromeUpdater } from '../desktop/chrome-update'
import { redactText } from '../redaction'
import { convergeDriveFile } from './files'

const execFileAsync = promisify(execFile)
const MAX_ENTRIES = 200
const COMMANDS = new Map<string, readonly [string, ...string[]]>([
  ['pwd', ['pwd']],
  ['uptime', ['uptime']],
  ['df -h', ['df', '-h']],
  ['du -sh .', ['du', '-sh', '.']],
  ['git status --short', ['git', 'status', '--short']],
])

export function createInternalAdminRoutes(args: {
  driveDir: string
  stateDir: string
  now?: () => number
  runCommand?: typeof defaultRunCommand
  status?: () => Record<string, unknown>
  updateChrome?: ChromeUpdater['update']
}): Hono {
  const app = new Hono()
  const root = resolve(args.driveDir)
  const stateRoot = resolve(args.stateDir)
  const now = args.now ?? Date.now
  const runCommand = args.runCommand ?? defaultRunCommand
  // The drive-local staging home every gateway write already uses; it must sit
  // on the drive's own filesystem so the temp-then-rename install is atomic.
  const tempDir = resolve(args.driveDir, '.duet', 'uploads')

  app.get('/status', c => c.json(args.status?.() ?? {}))

  app.post('/chrome-update', async c => {
    if (args.updateChrome === undefined) return c.json({ error: 'chrome_update_unavailable' }, 503)
    try {
      const result = await args.updateChrome()
      return result.ok ? c.json(result) : c.json({ error: result.error }, 409)
    } catch {
      return c.json({ error: 'chrome_update_failed' }, 502)
    }
  })

  /**
   * Make the given roots hold exactly the given files.
   *
   * Writes only what differs — see `convergeDriveFile` for why a byte-identical
   * rewrite is harmful — and reaps what the request no longer claims, so a
   * deletion or a rename at the source reaches this drive at all.
   *
   * Two things bound the reap. The publish floor survives, which is what lets
   * an agent's `node_modules`, installed on this VM, coexist with a folder the
   * repo owns — and what keeps `.duet-anchor`, whose absence makes this gateway
   * refuse the folder as a hijack, from being removed by its own update. And a
   * root the request does not name is never walked, so dropping a folder from
   * the caller's manifest still means "stops being managed" rather than "gets
   * erased."
   *
   * Containment is re-checked here rather than trusted from the caller. The
   * caller is first-party, but the blast radius of a bug in it is somebody's
   * drive.
   */
  app.post('/converge-subtree', async c => {
    const parsed = GatewayConvergeSubtreeRequestSchema.safeParse(
      await c.req.raw.json().catch(() => null),
    )
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)

    // NORMALIZE BEFORE CHECKING SCOPE. `agents/alpha/../../escape.md` starts
    // with `agents/alpha/` and sails straight through a raw prefix test; only
    // the canonical path can be compared against a root honestly.
    const planned: Array<{ path: string; bytes: Uint8Array }> = []
    for (const file of parsed.data.files) {
      const safe = normalizeDrivePath(file.path)
      if (!safe.ok) return c.json({ error: 'invalid_path', path: file.path }, 400)
      planned.push({
        path: safe.relativePath,
        bytes: new Uint8Array(Buffer.from(file.base64, 'base64')),
      })
    }

    const roots = parsed.data.roots.map(entry => entry.replace(/\/+$/, ''))
    // Strictly BENEATH a root, never equal to it: `isDrivePathWithin` would
    // admit a file written AT `agents/alpha`, replacing the directory the root
    // names.
    const outside = planned.filter(
      file => !roots.some(rootPath => file.path.startsWith(`${rootPath}/`)),
    )
    // The whole request fails rather than the stray path being skipped: a
    // caller that sent one out-of-scope path has a bug, and half-applying its
    // intent is worse than applying none of it.
    if (outside.length > 0) {
      return c.json({ error: 'path_outside_roots', paths: outside.map(file => file.path) }, 400)
    }

    const written: string[] = []
    let unchanged = 0
    for (const file of planned) {
      const outcome = await convergeDriveFile({
        driveDir: args.driveDir,
        tempDir,
        relativePath: file.path,
        bytes: file.bytes,
      })
      if (outcome === 'written') written.push(file.path)
      else if (outcome === 'unchanged') unchanged += 1
      else if (outcome === 'symlink') {
        return c.json({ error: 'path_is_symlink', path: file.path }, 409)
      } else return c.json({ error: 'invalid_path', path: file.path }, 400)
    }
    // Under a managed root the caller's plan is the whole truth, so anything on
    // disk it no longer claims is reaped. This is a DIFF, never a wipe: the
    // publish ETag is derived from file stat, so rewriting identical bytes
    // would mint a new archive ETag and push a full re-download to every
    // subscriber on a sync that changed nothing.
    //
    // Scoped to the roots the plan names, which is what keeps demotion working:
    // an agent dropped from the manifest is not in `roots`, so its folder is
    // never walked and keeps serving its last bytes.
    const claimed = new Set(planned.map(file => file.path))
    const deleted: string[] = []
    for (const rootPath of roots) {
      const outcome = await reapUnclaimed(args.driveDir, rootPath, claimed, deleted)
      if (outcome !== 'ok') return c.json({ error: outcome }, 409)
    }
    deleted.sort()
    return c.json({ written, unchanged, deleted })
  })

  // Operator log read. `/file` cannot serve these: it is contained to the drive
  // and every log lives under the state dir, which is deliberately outside it.
  // The sources are enumerated rather than path-addressed because the state dir
  // also holds the model and app credential stores and these responses are not
  // redacted.
  app.get('/logs', async c => {
    const available = await listLogs(stateRoot)
    const source = c.req.query('source') ?? 'gateway'
    if (source !== 'gateway' && source !== 'agent') return c.json({ error: 'invalid_source' }, 400)
    const anchorId = c.req.query('anchorId') ?? undefined
    if (anchorId !== undefined && !isSafeAnchorSegment(anchorId)) {
      return c.json({ error: 'invalid_anchor' }, 400)
    }
    const path = logPathFor(stateRoot, source, anchorId)
    const tail = await readLogTail(path)
    if (tail === null) return c.json({ error: 'not_found', available }, 404)
    return c.json({
      source,
      ...(anchorId === undefined ? {} : { anchorId }),
      path: relative(stateRoot, path).split(sep).join('/'),
      content: tail.content,
      byteLength: tail.byteLength,
      truncated: tail.truncated,
      available,
    })
  })

  app.get('/files', async c => {
    const containmentRoot = await realpath(root)
    const path = await safePath(containmentRoot, c.req.query('path') ?? '')
    if (path === null) return c.json({ error: 'invalid_path' }, 400)
    const rows = await readdir(path, { withFileTypes: true })
    const entries: Array<{
      name: string
      path: string
      kind: 'directory' | 'file'
      size?: number
    }> = []
    let truncated = false
    for (const entry of rows) {
      const full = resolve(path, entry.name)
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) continue
      if (entries.length === MAX_ENTRIES) {
        truncated = true
        break
      }
      entries.push({
        name: entry.name,
        path: relative(containmentRoot, full).split(sep).join('/'),
        kind: entry.isDirectory() ? 'directory' : 'file',
        ...(entry.isFile() ? { size: stat.size } : {}),
      })
    }
    return c.json({
      path: relative(containmentRoot, path).split(sep).join('/'),
      entries,
      truncated,
    })
  })

  app.get('/file', async c => {
    const containmentRoot = await realpath(root)
    const path = await safePath(containmentRoot, c.req.query('path') ?? '')
    if (path === null || path === containmentRoot) return c.json({ error: 'invalid_path' }, 400)
    const stat = await lstat(path)
    if (!stat.isFile()) return c.json({ error: 'not_file' }, 400)
    const handle = await open(path, 'r')
    const buffer = Buffer.alloc(INTERNAL_ADMIN_MAX_FILE_BYTES + 1)
    const { bytesRead } = await handle
      .read(buffer, 0, buffer.byteLength, 0)
      .finally(() => handle.close())
    const slice = buffer.subarray(0, Math.min(bytesRead, INTERNAL_ADMIN_MAX_FILE_BYTES))
    return c.json({
      path: relative(containmentRoot, path).split(sep).join('/'),
      content: redactText(slice.toString('utf8')),
      byteLength: stat.size,
      truncated: bytesRead > INTERNAL_ADMIN_MAX_FILE_BYTES || stat.size > slice.byteLength,
    })
  })

  app.post('/command', async c => {
    const body = (await c.req.json().catch(() => null)) as { command?: unknown } | null
    if (typeof body?.command !== 'string') return c.json({ error: 'invalid_request' }, 400)
    const argv = COMMANDS.get(body.command.trim())
    if (argv === undefined) return c.json({ error: 'command_not_allowed' }, 400)
    const startedAt = now()
    try {
      const result = await runCommand(argv[0], argv.slice(1), {
        cwd: root,
        timeout: INTERNAL_ADMIN_COMMAND_TIMEOUT_MS,
        maxBuffer: INTERNAL_ADMIN_MAX_COMMAND_OUTPUT_BYTES * 2,
      })
      return c.json(
        commandResult(body.command.trim(), result.stdout, result.stderr, 0, now() - startedAt),
      )
    } catch (error) {
      const value = error as Error & {
        stdout?: string
        stderr?: string
        code?: number | string
        killed?: boolean
      }
      if (value.killed) return c.json({ error: 'command_timeout' }, 504)
      if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return c.json(
          commandResult(
            body.command.trim(),
            value.stdout ?? '',
            value.stderr ?? '',
            0,
            now() - startedAt,
            true,
          ),
        )
      }
      return c.json(
        commandResult(
          body.command.trim(),
          value.stdout ?? '',
          value.stderr ?? value.message,
          typeof value.code === 'number' ? value.code : 1,
          now() - startedAt,
        ),
      )
    }
  })

  return app
}

async function defaultRunCommand(
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(file, args, options)
}

async function safePath(root: string, input: string): Promise<string | null> {
  if (input.includes('\0')) return null
  const lexical = resolve(root, input.replace(/^[/\\]+/, ''))
  if (lexical !== root && !lexical.startsWith(`${root}${sep}`)) return null
  try {
    const target = await realpath(lexical)
    return target === root || target.startsWith(`${root}${sep}`) ? target : null
  } catch {
    return null
  }
}

function commandResult(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  durationMs: number,
  forceTruncated = false,
) {
  const combined = Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
  const remaining = INTERNAL_ADMIN_MAX_COMMAND_OUTPUT_BYTES
  const out = Buffer.from(stdout).subarray(0, remaining).toString('utf8')
  const err = Buffer.from(stderr)
    .subarray(0, Math.max(0, remaining - Buffer.byteLength(out)))
    .toString('utf8')
  return {
    command,
    stdout: redactText(out),
    stderr: redactText(err),
    exitCode,
    durationMs: Math.max(0, durationMs),
    truncated: forceTruncated || combined > INTERNAL_ADMIN_MAX_COMMAND_OUTPUT_BYTES,
  }
}

// Anchor ids address a directory under the state dir, so they must never carry
// separators or dot segments.
function isSafeAnchorSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function logPathFor(stateRoot: string, source: 'gateway' | 'agent', anchorId?: string): string {
  if (source === 'gateway') return join(stateRoot, 'logs', 'gateway.log')
  return anchorId === undefined
    ? join(stateRoot, 'logs.log')
    : join(stateRoot, 'agents', anchorId, 'logs.log')
}

/** The NEWEST bytes: logs are capped from the front, so the head is the stale end. */
async function readLogTail(
  path: string,
): Promise<{ content: string; byteLength: number; truncated: boolean } | null> {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  const start = Math.max(0, stat.size - INTERNAL_ADMIN_MAX_FILE_BYTES)
  const length = Math.min(stat.size, INTERNAL_ADMIN_MAX_FILE_BYTES)
  if (length === 0) return { content: '', byteLength: stat.size, truncated: false }
  const handle = await open(path, 'r')
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start).finally(() => handle.close())
  return {
    content: buffer.subarray(0, bytesRead).toString('utf8'),
    byteLength: stat.size,
    truncated: start > 0,
  }
}

async function listLogs(
  stateRoot: string,
): Promise<Array<{ source: 'gateway' | 'agent'; anchorId?: string; byteLength: number }>> {
  const found: Array<{ source: 'gateway' | 'agent'; anchorId?: string; byteLength: number }> = []
  for (const candidate of [
    { source: 'gateway' as const, path: logPathFor(stateRoot, 'gateway') },
    { source: 'agent' as const, path: logPathFor(stateRoot, 'agent') },
  ]) {
    const size = await fileSize(candidate.path)
    if (size !== null) found.push({ source: candidate.source, byteLength: size })
  }
  let anchors: string[] = []
  try {
    anchors = (await readdir(join(stateRoot, 'agents'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && isSafeAnchorSegment(entry.name))
      .map(entry => entry.name)
  } catch {
    anchors = []
  }
  for (const anchorId of anchors.sort()) {
    const size = await fileSize(logPathFor(stateRoot, 'agent', anchorId))
    if (size !== null) found.push({ source: 'agent', anchorId, byteLength: size })
  }
  return found
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const stat = await lstat(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

/**
 * Delete every file under `rootPath` that `claimed` does not name, then remove
 * the directories that emptying leaves behind — otherwise a renamed folder
 * survives forever as a husk.
 *
 * Never touches the publish floor (`node_modules`, `.git`, `.duet-anchor`,
 * `.env*`). Two of those matter here for different reasons: an installed
 * dependency tree is not ours to delete, and `.duet-anchor` is the marker whose
 * absence makes the gateway refuse to serve the folder as a hijack — reaping it
 * would break the very agent the sync is updating.
 */
async function reapUnclaimed(
  driveDir: string,
  rootPath: string,
  claimed: ReadonlySet<string>,
  deleted: string[],
): Promise<'ok' | 'recursive_limit_exceeded'> {
  const absoluteRoot = join(driveDir, rootPath)
  const directories: string[] = []
  let seen = 0

  const walk = async (relativeDir: string): Promise<'ok' | 'recursive_limit_exceeded'> => {
    let names: string[]
    try {
      names = await readdir(join(driveDir, relativeDir))
    } catch {
      // A root the plan names but the drive has never held is not an error:
      // the write pass above just created it, or there is nothing to reap.
      return 'ok'
    }
    for (const name of names) {
      const relativePath = `${relativeDir}/${name}`
      if (isPublishExcludedDrivePath(relativePath)) continue
      seen += 1
      if (seen > MAX_RECURSIVE_FILE_ENTRIES) return 'recursive_limit_exceeded'
      const info = await lstat(join(driveDir, relativePath))
      // A symlink is never followed and never reaped — the same rule the
      // publish subtree walk applies.
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        directories.push(relativePath)
        const outcome = await walk(relativePath)
        if (outcome !== 'ok') return outcome
        continue
      }
      if (!info.isFile() || claimed.has(relativePath)) continue
      await unlink(join(driveDir, relativePath))
      deleted.push(relativePath)
    }
    return 'ok'
  }

  if (!(await isDirectory(absoluteRoot))) return 'ok'
  const outcome = await walk(rootPath)
  if (outcome !== 'ok') return outcome

  // Deepest first, so a directory whose only contents were reaped children is
  // itself empty by the time it is considered. `rmdir` refuses a non-empty
  // directory, which is exactly the guard wanted: anything still holding a
  // floor path or a claimed file simply stays.
  for (const relativePath of directories.sort((left, right) => right.length - left.length)) {
    await rmdir(join(driveDir, relativePath)).catch(() => undefined)
  }
  return 'ok'
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await lstat(absolutePath)).isDirectory()
  } catch {
    return false
  }
}
