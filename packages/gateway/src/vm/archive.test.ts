import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { VmRestoreCommand } from '@repo/contract'

import { completePendingRestore, persistPendingRestore } from './archive'
import decoder from './restore-zip.py' with { type: 'text' }

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'drive-restore-'))
  roots.push(root)
  const driveDir = join(root, 'mounted-drive')
  const stateDir = join(root, '.duet')
  await mkdir(driveDir)
  await mkdir(stateDir)
  return { root, driveDir, stateDir }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function zip(root: string, entries: Record<string, string>) {
  const path = join(root, 'backup.zip')
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      'import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as z:\n for n,v in json.loads(sys.argv[2]).items(): z.writestr(n,v)',
      path,
      JSON.stringify(entries),
    ],
    { stderr: 'pipe' },
  )
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  return new Uint8Array(await readFile(path))
}
function descriptor(body: Uint8Array) {
  return {
    kind: 'workspace-backup' as const,
    backupId: 'backup-1',
    bytes: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
    refreshUrl: 'https://api/restore',
    download: { url: 'https://blob/backup', expiresAt: Date.now() + 60_000 },
  }
}
function controlResponse(init: RequestInit) {
  const command = JSON.parse(String(init.body)) as VmRestoreCommand
  return Response.json(
    command.kind === 'claim'
      ? { status: 'running', processedBytes: 0, processedEntries: 0 }
      : { ok: true },
  )
}
test('ZIP restore replaces only Drive children and preserves the mounted root and VM state', async () => {
  const f = await fixture()
  await writeFile(join(f.driveDir, 'old'), 'old')
  await writeFile(join(f.stateDir, 'vm-token'), 'current')
  const before = await stat(f.driveDir)
  const body = await zip(f.root, {
    'drive/file': 'restored',
    'workspace/settings.json': '{}',
    '.duet/vm-token': 'old',
  })
  await persistPendingRestore(f.stateDir, descriptor(body))
  await completePendingRestore({
    ...f,
    fetch: async (_url, init) => {
      if (init?.method === 'POST') return controlResponse(init)
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return new Response(body.slice())
    },
    getVmToken: () => 'current',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
  })
  expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('restored')
  expect((await stat(f.driveDir)).ino).toBe(before.ino)
  expect(await readFile(join(f.stateDir, 'vm-token'), 'utf8')).toBe('current')
  await expect(stat(join(f.driveDir, 'old'))).rejects.toThrow()
  await expect(stat(join(f.root, 'workspace'))).rejects.toThrow()
})

test('expired private grants refresh with VM authority, then retry from retained descriptor after failure', async () => {
  const f = await fixture()
  const body = await zip(f.root, { 'drive/file': 'restored' })
  const restore = descriptor(body)
  restore.download.expiresAt = 0
  await persistPendingRestore(f.stateDir, restore)
  const calls: string[] = []
  let fail = true
  const fetch: Parameters<typeof completePendingRestore>[0]['fetch'] = async (url, init) => {
    if (init?.method === 'POST') return controlResponse(init)
    calls.push(String(url))
    if (url === restore.refreshUrl) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current')
      return Response.json({ url: 'https://blob/fresh', expiresAt: Date.now() + 60_000 })
    }
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    return fail ? new Response('failed', { status: 503 }) : new Response(body.slice())
  }
  const args = {
    ...f,
    fetch,
    getVmToken: () => 'current',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
  }
  await expect(completePendingRestore(args)).rejects.toThrow('503')
  fail = false
  await completePendingRestore(args)
  expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('restored')
  expect(calls).toEqual([
    restore.refreshUrl,
    'https://blob/fresh',
    restore.refreshUrl,
    'https://blob/fresh',
  ])
})

test('Drive selection is case sensitive', async () => {
  const f = await fixture()
  const body = await zip(f.root, { 'Drive/private': 'not Drive', 'drive/kept': 'kept' })
  await persistPendingRestore(f.stateDir, descriptor(body))
  await completePendingRestore({
    ...f,
    fetch: async (_url, init) =>
      init?.method === 'POST' ? controlResponse(init) : new Response(body.slice()),
    getVmToken: () => 'token',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
  })
  expect(await readFile(join(f.driveDir, 'kept'), 'utf8')).toBe('kept')
  await expect(stat(join(f.driveDir, 'private'))).rejects.toThrow()
})

async function typedZip(
  root: string,
  entries: Array<{ name: string; content?: string; mode?: number }>,
) {
  const path = join(root, 'typed.zip')
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      `import zipfile,json,sys,struct
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as z:
 for e in json.loads(sys.argv[2]):
  i=zipfile.ZipInfo(e['name']); i.create_system=3; i.external_attr=e.get('mode', 0o100644)<<16
  i.extra=struct.pack('<HHBI', 0x5455,5,1,1735787045)
  with z.open(i,'w',force_zip64=True) as f: f.write(e.get('content','').encode())`,
      path,
      JSON.stringify(entries),
    ],
    { stderr: 'pipe' },
  )
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  return new Uint8Array(await readFile(path))
}
async function restoreBytes(f: Awaited<ReturnType<typeof fixture>>, body: Uint8Array) {
  await persistPendingRestore(f.stateDir, descriptor(body))
  await completePendingRestore({
    ...f,
    fetch: async (_url, init) =>
      init?.method === 'POST' ? controlResponse(init) : new Response(body.slice()),
    getVmToken: () => 'token',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
  })
}
test('ZIP64 entries preserve modes, timestamps, empty directories and external or dangling links', async () => {
  const f = await fixture()
  const body = await typedZip(f.root, [
    { name: 'drive/empty/', mode: 0o40550 },
    { name: 'drive/run', content: '#!/bin/sh\n', mode: 0o100751 },
    ...['/etc/hosts', '../../outside', 'missing'].map((content, i) => ({
      name: `drive/link${i}`,
      content,
      mode: 0o120777,
    })),
  ])
  await restoreBytes(f, body)
  expect((await stat(join(f.driveDir, 'empty'))).mode & 0o777).toBe(0o550)
  expect((await stat(join(f.driveDir, 'run'))).mode & 0o777).toBe(0o751)
  expect((await stat(join(f.driveDir, 'run'))).mtimeMs).toBe(1735787045000)
  expect(await readFile(join(f.driveDir, 'run'), 'utf8')).toBe('#!/bin/sh\n')
  for (const [i, target] of ['/etc/hosts', '../../outside', 'missing'].entries())
    expect(await readlink(join(f.driveDir, `link${i}`))).toBe(target)
})

test('malformed paths, duplicate entries, link parents and node types leave existing Drive intact', async () => {
  const f = await fixture()
  await writeFile(join(f.driveDir, 'original'), 'untouched')
  for (const entries of [
    [{ name: 'drive/../outside', content: 'bad' }],
    [{ name: '/absolute', content: 'bad' }],
    [
      { name: 'drive/a', content: 'a' },
      { name: 'drive/a', content: 'b' },
    ],
    [
      { name: 'drive/parent/child', content: 'bad' },
      { name: 'drive/parent', content: '/tmp', mode: 0o120777 },
    ],
    [{ name: 'drive', content: '/tmp', mode: 0o120777 }],
    [{ name: 'drive/fifo', mode: 0o10600 }],
  ]) {
    await expect(restoreBytes(f, await typedZip(f.root, entries))).rejects.toThrow(
      'archive restore rejected',
    )
    expect(await readFile(join(f.driveDir, 'original'), 'utf8')).toBe('untouched')
  }
})

test('checksum and central-directory corruption are rejected before replacing Drive', async () => {
  const f = await fixture()
  await writeFile(join(f.driveDir, 'original'), 'untouched')
  const body = await zip(f.root, { 'drive/entry': 'data' })
  const d = descriptor(body)
  d.sha256 = '0'.repeat(64)
  await persistPendingRestore(f.stateDir, d)
  await expect(
    completePendingRestore({
      ...f,
      fetch: async (_url, init) =>
        init?.method === 'POST' ? controlResponse(init) : new Response(body.slice()),
      getVmToken: () => 'token',
      extraHeaders: {},
    }),
  ).rejects.toThrow('checksum')
  const bad = body.slice()
  new DataView(bad.buffer).setUint16(bad.length - 22 + 10, 2, true)
  await expect(restoreBytes(f, bad)).rejects.toThrow('archive restore rejected')
  expect(await readFile(join(f.driveDir, 'original'), 'utf8')).toBe('untouched')
})

test('insufficient disk for the advertised download fails without disturbing Drive', async () => {
  const f = await fixture()
  await writeFile(join(f.driveDir, 'original'), 'untouched')
  const d = descriptor(new Uint8Array())
  d.bytes = Number.MAX_SAFE_INTEGER
  await persistPendingRestore(f.stateDir, d)
  await expect(
    completePendingRestore({
      ...f,
      fetch: async (_url, init) => {
        if (init?.method === 'POST') return controlResponse(init)
        throw new Error('must reject before downloading')
      },
      getVmToken: () => 'token',
      extraHeaders: {},
    }),
  ).rejects.toThrow('restore_insufficient_disk_space')
  expect(await readFile(join(f.driveDir, 'original'), 'utf8')).toBe('untouched')
})

test('ZIP64 central directory supports more than 65535 entries', async () => {
  const f = await fixture()
  const path = join(f.root, 'many.zip')
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for i in range(65536): z.writestr('workspace/records/'+str(i), '')
 z.writestr('drive/kept', 'restored')`,
      path,
    ],
    { stderr: 'pipe' },
  )
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  await restoreBytes(f, new Uint8Array(await readFile(path)))
  expect(await readFile(join(f.driveDir, 'kept'), 'utf8')).toBe('restored')
}, 30_000)

test('Unix backslashes remain literal filename bytes', async () => {
  const f = await fixture()
  const body = await zip(f.root, { 'drive/notes\\draft.txt': 'literal' })
  await restoreBytes(f, body)
  expect(await readFile(join(f.driveDir, 'notes\\draft.txt'), 'utf8')).toBe('literal')
})

test('extraction capacity includes block allocation for tiny files and directories', async () => {
  const f = await fixture()
  await zip(f.root, { 'drive/tiny': 'x', 'drive/empty/': '' })
  const output = join(f.root, 'extract')
  await mkdir(output)
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      `import shutil,types
shutil.disk_usage = lambda path: types.SimpleNamespace(free=16 * 1024 * 1024 + 1024)
${decoder}`,
      join(f.root, 'backup.zip'),
      output,
      f.driveDir,
    ],
    { stderr: 'pipe' },
  )
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code).toBe(1)
  expect(error).toContain('restore_insufficient_disk_space')
  await expect(stat(join(output, 'drive'))).rejects.toThrow()
})

test('extraction never follows a filesystem alias of an archive symlink', async () => {
  const f = await fixture()
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  const body = await typedZip(f.root, [
    { name: 'drive/A', content: outside, mode: 0o120777 },
    { name: 'drive/a/injected', content: 'escape' },
  ])
  // Case-sensitive filesystems can install both names. Case-insensitive ones
  // must reject the alias instead of traversing the earlier link.
  await restoreBytes(f, body).catch(() => undefined)
  await expect(stat(join(outside, 'injected'))).rejects.toThrow()
})

test('restore reports real work and retries a lost installed acknowledgement without replacing Drive again', async () => {
  const f = await fixture()
  const body = await zip(f.root, { 'drive/file': 'restored' })
  await persistPendingRestore(f.stateDir, descriptor(body))
  const commands: VmRestoreCommand[] = []
  let loseAck = true
  const args = {
    ...f,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://api/restore') return new Response(body.slice())
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current')
      const command = JSON.parse(String(init?.body))
      commands.push(command)
      if (command.kind === 'claim')
        return Response.json({ status: 'running', processedBytes: 100, processedEntries: 10 })
      if (command.kind === 'installed' && loseAck) throw new Error('lost acknowledgement')
      return Response.json({ ok: true })
    },
    getVmToken: () => 'current',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
  }
  await expect(completePendingRestore(args)).rejects.toThrow('lost acknowledgement')
  expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('restored')
  await writeFile(join(f.driveDir, 'file'), 'edited after installation')
  loseAck = false
  await completePendingRestore(args)
  expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('edited after installation')
  const progress = commands.filter(c => c.kind === 'progress')
  expect(new Set(progress.map(p => p.phase))).toEqual(
    new Set(['download', 'index', 'extract', 'install']),
  )
  expect(progress.at(-1)?.processedBytes).toBeGreaterThan(100 + body.length)
  expect(progress.at(-1)?.processedEntries).toBeGreaterThan(10)
  for (let i = 1; i < progress.length; i++) {
    expect(progress[i]!.processedBytes).toBeGreaterThanOrEqual(progress[i - 1]!.processedBytes)
    expect(progress[i]!.processedEntries).toBeGreaterThanOrEqual(progress[i - 1]!.processedEntries)
  }
  expect(new Set(commands.map(c => c.attemptId)).size).toBe(1)
  expect(commands.some(c => c.kind === 'failed')).toBe(false)
  await expect(stat(join(f.stateDir, 'pending-restore.json'))).rejects.toThrow()
})

test('failed settlement follows stream cancellation and a lost acknowledgement retires the attempt before retry', async () => {
  const f = await fixture()
  const body = await zip(f.root, { 'drive/file': 'restored' })
  await persistPendingRestore(f.stateDir, descriptor(body))
  let cancelled = false
  let failureSawCancelled = false
  let failedAttempt: string | undefined
  let restored = false
  const claims: string[] = []
  const args = {
    ...f,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === 'https://api/restore') {
        const command = JSON.parse(String(init?.body)) as VmRestoreCommand
        if (command.kind === 'claim') {
          claims.push(command.attemptId)
          return Response.json({
            status: command.attemptId === failedAttempt ? 'failed' : 'running',
            processedBytes: 0,
            processedEntries: 0,
          })
        }
        if (command.kind === 'failed') {
          failureSawCancelled = cancelled
          failedAttempt = command.attemptId
          throw new Error('lost failed acknowledgement')
        }
        return Response.json({ ok: true })
      }
      if (restored) return new Response(body.slice())
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(body.length + 1))
          },
          async cancel() {
            await Promise.resolve()
            cancelled = true
          },
        }),
      )
    },
    getVmToken: () => 'token',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
  }
  await expect(completePendingRestore(args)).rejects.toThrow('size mismatch')
  expect(failureSawCancelled).toBe(true)
  await expect(completePendingRestore(args)).rejects.toThrow('already failed')
  restored = true
  await completePendingRestore(args)
  expect(claims[0]).toBe(claims[1])
  expect(claims[2]).not.toBe(claims[0])
  expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('restored')
})

test('a lost final progress response retains the installed Drive and its restore notification', async () => {
  const f = await fixture()
  const body = await zip(f.root, { 'drive/file': 'restored' })
  await persistPendingRestore(f.stateDir, descriptor(body))
  let loseResponse = true
  let emitted = 0
  const commands: VmRestoreCommand[] = []
  const args = {
    ...f,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://api/restore') return new Response(body.slice())
      const command = JSON.parse(String(init?.body)) as VmRestoreCommand
      commands.push(command)
      if (command.kind === 'claim')
        return Response.json({ status: 'running', processedBytes: 0, processedEntries: 0 })
      if (
        command.kind === 'progress' &&
        command.phase === 'install' &&
        loseResponse &&
        (await readFile(join(f.driveDir, 'file'), 'utf8').catch(() => '')) === 'restored'
      )
        throw new Error('lost final progress')
      return Response.json({ ok: true })
    },
    getVmToken: () => 'token',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
    suppression: {
      begin() {},
      end() {},
      emitOne() {
        emitted++
      },
    },
  }
  await expect(completePendingRestore(args)).rejects.toThrow('lost final progress')
  await writeFile(join(f.driveDir, 'file'), 'edited after installation')
  // A new registration may refresh the grant while settlement is pending.
  await persistPendingRestore(f.stateDir, descriptor(body))
  loseResponse = false
  await completePendingRestore(args)
  expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('edited after installation')
  expect(commands.some(command => command.kind === 'failed')).toBe(false)
  expect(emitted).toBe(1)
})

test('control-plane abandonment retires a failed restore so later sync prerequisites can complete', async () => {
  const f = await fixture()
  await writeFile(join(f.driveDir, 'existing'), 'keep current Drive')
  const body = await zip(f.root, { 'drive/restored': 'unused backup' })
  await persistPendingRestore(f.stateDir, descriptor(body))
  let abandoned = false
  let emitted = 0
  const args = {
    ...f,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://api/restore') return new Response('unavailable', { status: 503 })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token')
      const command = JSON.parse(String(init?.body)) as VmRestoreCommand
      return command.kind === 'claim'
        ? Response.json({
            status: abandoned ? 'abandoned' : 'running',
            processedBytes: 0,
            processedEntries: 0,
          })
        : Response.json({ ok: true })
    },
    getVmToken: () => 'token',
    extraHeaders: {},
    runCommand: async () => ({ exitCode: 0 }),
    suppression: {
      begin() {},
      end() {},
      emitOne() {
        emitted++
      },
    },
  }
  await expect(completePendingRestore(args)).rejects.toThrow('503')
  abandoned = true
  await completePendingRestore(args)
  await completePendingRestore({
    ...args,
    fetch: async () => {
      throw new Error('No pending restore remains')
    },
  })
  expect(await readFile(join(f.driveDir, 'existing'), 'utf8')).toBe('keep current Drive')
  await expect(stat(join(f.stateDir, 'pending-restore.json'))).rejects.toThrow()
  await expect(stat(join(f.driveDir, 'restored'))).rejects.toThrow()
  expect(emitted).toBe(0)
})

test.each(['old Drive', 'scratch'])(
  'lost cleanup progress finishes disposing %s before retrying installed acknowledgement',
  async target => {
    const f = await fixture()
    for (const name of ['old-a', 'old-b', 'old-c']) await writeFile(join(f.driveDir, name), name)
    const body = await zip(f.root, { 'drive/file': 'restored' })
    const restore = descriptor(body)
    restore.download.expiresAt = Number.MAX_SAFE_INTEGER
    await persistPendingRestore(f.stateDir, restore)
    const originalTmpdir = process.env.TMPDIR
    process.env.TMPDIR = f.root
    let now = Date.now()
    // Model slow disposal so each completed entry reaches the reporting interval.
    const clock = spyOn(Date, 'now').mockImplementation(() => (now += 11_000))
    let cleanupFailures = 0
    const args = {
      ...f,
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== restore.refreshUrl) return new Response(body.slice())
        const command = JSON.parse(String(init?.body)) as VmRestoreCommand
        if (command.kind === 'claim')
          return Response.json({ status: 'running', processedBytes: 0, processedEntries: 0 })
        if (command.kind === 'progress' && command.phase === 'install') {
          const previous = (await readdir(f.driveDir)).find(name =>
            name.startsWith('.duet-restore-old-'),
          )
          const scratch = (await readdir(f.root)).find(name => name.startsWith('duet-restore-'))
          const disposing =
            target === 'old Drive'
              ? previous && (await readdir(join(f.driveDir, previous))).length === 2
              : !previous && scratch && (await readdir(join(f.root, scratch))).length === 1
          if (
            disposing &&
            JSON.parse(await readFile(join(f.stateDir, 'pending-restore.json'), 'utf8')).installed
          ) {
            cleanupFailures++
            throw new Error('lost cleanup progress')
          }
        }
        return Response.json({ ok: true })
      },
      getVmToken: () => 'token',
      extraHeaders: {},
      runCommand: async () => ({ exitCode: 0 }),
    }
    try {
      await expect(completePendingRestore(args)).rejects.toThrow('lost cleanup progress')
      expect(await readdir(f.driveDir)).toEqual(['file'])
      expect((await readdir(f.root)).filter(name => name.startsWith('duet-restore-'))).toEqual([])
      expect(cleanupFailures).toBe(1)
      await writeFile(join(f.driveDir, 'file'), 'edited after installation')
      await completePendingRestore(args)
      expect(await readFile(join(f.driveDir, 'file'), 'utf8')).toBe('edited after installation')
      await expect(stat(join(f.stateDir, 'pending-restore.json'))).rejects.toThrow()
    } finally {
      clock.mockRestore()
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
    }
  },
)
