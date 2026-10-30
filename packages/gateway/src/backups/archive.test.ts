import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildWorkspaceBackup } from './archive'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const capture = {
  backupId: 'fixture',
  workspace: { name: 'Fixture', slug: 'fixture' },
  createdAt: 1700000000000,
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'backup-test-'))
  roots.push(root)
  const drive = join(root, 'configured-drive')
  await mkdir(drive)
  return { root, drive }
}
async function extract(root: string, body: ReadableStream<Uint8Array>) {
  const zip = join(root, 'backup.zip')
  const sink = Bun.file(zip).writer()
  for await (const chunk of body) {
    sink.write(chunk)
    await sink.flush()
  }
  await sink.end()
  const output = join(root, 'extracted')
  await mkdir(output)
  const child = Bun.spawn(['bsdtar', '-xpf', zip, '-C', output], { stderr: 'pipe' })
  expect(await new Response(child.stderr).text()).toBe('')
  expect(await child.exited).toBe(0)
  return output
}
test('complete configured Drive independently extracts unchanged with modes, links and streamed records', async () => {
  const { root, drive } = await fixture()
  for (const dir of ['.git', '.cache', 'node_modules', 'empty', 'nested/.hidden'])
    await mkdir(join(drive, dir), { recursive: true })
  const paths = [
    '.env',
    '.env.local',
    '.gitignore',
    '.git/config',
    '.cache/data',
    'node_modules/pkg',
    'nested/.hidden/雪\n space',
    'run.sh',
    'readonly',
  ]
  for (const path of paths) await writeFile(join(drive, path), Buffer.from([0, 1, 255, 42]))
  await chmod(join(drive, 'run.sh'), 0o755)
  await chmod(join(drive, 'readonly'), 0o444)
  await link(join(drive, '.env'), join(drive, 'hardlink'))
  await writeFile(join(root, 'outside'), 'must not follow')
  for (const [name, target] of [
    ['dangling', 'missing'],
    ['external', '../outside'],
    ['absolute', join(root, 'outside')],
  ])
    await symlink(target!, join(drive, name!))
  const result = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    records: (async function* () {
      yield {
        path: 'workspace/settings.json',
        body: (async function* () {
          yield new TextEncoder().encode('{"purpose":"test"}')
        })(),
      }
    })(),
  })
  const out = await extract(root, result.body)
  const summary = await result.completed
  expect(summary.completeness).toBe('complete')
  for (const path of [...paths, 'hardlink'])
    expect(await readFile(join(out, 'drive', path))).toEqual(Buffer.from([0, 1, 255, 42]))
  expect((await lstat(join(out, 'drive/run.sh'))).mode & 0o777).toBe(0o755)
  expect((await lstat(join(out, 'drive/readonly'))).mode & 0o777).toBe(0o444)
  expect((await lstat(join(out, 'drive/empty'))).isDirectory()).toBe(true)
  expect(await readlink(join(out, 'drive/external'))).toBe('../outside')
  expect(await readlink(join(out, 'drive/absolute'))).toBe(join(root, 'outside'))
  expect(await readlink(join(out, 'drive/dangling'))).toBe('missing')
  expect(await readFile(join(out, 'workspace/settings.json'), 'utf8')).toBe('{"purpose":"test"}')
  const inventory = (await readFile(join(out, 'inventory.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  for (const entry of inventory.filter(entry => entry.type === 'file'))
    expect(entry.sha256).toBe(
      createHash('sha256')
        .update(await readFile(join(out, entry.path)))
        .digest('hex'),
    )
  expect(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')).consistency).toBe('live')
  expect(await readFile(join(out, 'README.md'), 'utf8')).toContain('historical')
})

test('unsupported nodes and portable omissions produce an extractable partial archive', async () => {
  const { root, drive } = await fixture()
  expect(await Bun.spawn(['mkfifo', join(drive, 'pipe')]).exited).toBe(0)
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    records: (async function* () {
      yield {
        code: 'missing_image' as const,
        recordKey: 'img1',
        detail: 'Stored image unavailable',
      }
    })(),
  })
  const out = await extract(root, backup.body)
  expect((await backup.completed).completeness).toBe('partial')
  expect(
    (await readFile(join(out, 'warnings.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line)),
  ).toEqual([
    {
      code: 'unsupported_node',
      path: 'drive/pipe',
      detail: 'Socket, FIFO, or device cannot be represented in ZIP',
    },
    { code: 'missing_image', recordKey: 'img1', detail: 'Stored image unavailable' },
  ])
})

test('missing Drive fails instead of exporting an empty successful archive', async () => {
  const { drive } = await fixture()
  await rm(drive, { recursive: true })
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    records: (async function* () {})(),
  })
  await expect(
    (async () => {
      for await (const _ of backup.body) {
        /* drain */
      }
    })(),
  ).rejects.toThrow('Archive capture failed')
  await expect(backup.completed).rejects.toThrow('Archive capture failed')
})

test('abort interrupts a stalled metadata source and cancellation settles completion', async () => {
  const { drive } = await fixture()
  const controller = new AbortController()
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    signal: controller.signal,
    records: {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) }
      },
    },
  })
  controller.abort()
  await expect(backup.completed).rejects.toThrow()
  await backup.body.cancel().catch(() => {})
})

test('a file truncated during a backpressured read yields matching captured hashes and partial status', async () => {
  const { root, drive } = await fixture()
  const file = join(drive, 'changing')
  await writeFile(file, crypto.getRandomValues(new Uint8Array(8 * 1024 * 1024)))
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    records: (async function* () {})(),
  })
  let bytes = 0
  let mutated = false
  const reader = backup.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      bytes += next.value.length
      if (!mutated && bytes > 256 * 1024) {
        mutated = true
        await writeFile(file, 'replacement')
      }
      controller.enqueue(next.value)
    },
  })
  const out = await extract(root, body)
  expect(mutated).toBe(true)
  expect((await backup.completed).completeness).toBe('partial')
  const inventory = (await readFile(join(out, 'inventory.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const entry = inventory.find(entry => entry.path === 'drive/changing')
  const actual = await readFile(join(out, 'drive/changing'))
  expect(entry.sha256).toBe(createHash('sha256').update(actual).digest('hex'))
  expect(entry.bytes).toBe(actual.length)
  expect(await readFile(join(out, 'warnings.ndjson'), 'utf8')).toContain('source_changed')
})

test('a compressible file reports captured bytes before the entry closes without double counting', async () => {
  const { root, drive } = await fixture()
  const bytes = new Uint8Array(1024 * 1024)
  await writeFile(join(drive, 'large'), bytes)
  // Advance the clock at the real read seam, without a slow or enormous fixture.
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      `
import os, runpy, sys, time
original_read = os.read
elapsed = 0
def read(fd, size):
    global elapsed
    data = original_read(fd, size)
    elapsed += 0.25
    return data
os.read = read
time.monotonic = lambda: elapsed
runpy.run_path(sys.argv[1], run_name='__main__')
`,
      join(import.meta.dir, 'encoder.py'),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  child.stdin.write(JSON.stringify({ driveDir: drive, capture, readme: 'Fixture' }) + '\n')
  await child.stdin.end()
  const reports = new Response(child.stderr).text()
  const out = await extract(root, child.stdout)
  expect(await child.exited).toBe(0)
  const messages = (await reports)
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const progress = messages.flatMap(message => (message.progress ? [message.progress] : []))
  expect(
    progress.some(counts => counts.files === 0 && counts.bytes > 0 && counts.bytes < bytes.length),
  ).toBe(true)
  // Four seconds of capture should yield periodic reports, not one per read.
  expect(progress.length).toBeLessThanOrEqual(5)
  expect(progress.map(counts => counts.bytes)).toEqual(
    progress.map(counts => counts.bytes).toSorted((a, b) => a - b),
  )
  expect(messages.at(-1).summary.counts.bytes).toBe(bytes.length)
  expect(await readFile(join(out, 'drive/large'))).toEqual(Buffer.from(bytes))
})

test('portable stream buffers are released during capture', async () => {
  const { heapStats } = await import('bun:jsc')
  const { drive } = await fixture()
  let baseline = 0
  let growth = 0
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    records: (async function* () {
      yield {
        path: 'workspace/large',
        body: (async function* () {
          for (let index = 0; index < 1100; index++) {
            if (index === 100 || index === 1000) {
              Bun.gc(true)
              const heap = heapStats().heapSize
              if (index === 100) baseline = heap
              else growth = heap - baseline
            }
            yield new Uint8Array(64 * 1024)
          }
        })(),
      }
    })(),
  })
  for await (const _ of backup.body) {
    /* drain */
  }
  expect((await backup.completed).counts.bytes).toBe(1100 * 64 * 1024)
  // 56 MiB passes through between measurements; allocator/GC noise may use 16 MiB.
  expect(growth).toBeLessThan(16 * 1024 * 1024)
})

test('a paused consumer backpressures the portable producer and body cancellation stops it', async () => {
  const { drive } = await fixture()
  let produced = 0
  let began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  const bytes = crypto.getRandomValues(new Uint8Array(64 * 1024))
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture,
    records: (async function* () {
      yield {
        path: 'workspace/image',
        body: (async function* () {
          for (let index = 0; index < 512; index++) {
            produced++
            began()
            yield bytes
          }
        })(),
      }
    })(),
  })
  await started
  await Bun.sleep(100)
  expect(produced).toBeLessThan(512)
  await backup.body.cancel()
  await expect(backup.completed).rejects.toThrow()
})

test('a parent replaced with an external symlink is warned about without reading its target', async () => {
  const { root, drive } = await fixture()
  await mkdir(join(drive, 'victim'))
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside/secret'), 'outside bytes')
  // Interpose at the filesystem seam to reproduce replacement exactly between lstat and open.
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      `
import os, runpy, sys
original = os.stat
replaced = False
def race(path, **kwargs):
    global replaced
    result = original(path, **kwargs)
    if path == 'victim' and kwargs.get('dir_fd') is not None and not replaced:
        replaced = True
        os.rename(os.path.join(sys.argv[2], 'victim'), os.path.join(sys.argv[3], 'moved'))
        os.symlink(os.path.join(sys.argv[3], 'outside'), os.path.join(sys.argv[2], 'victim'))
    return result
os.stat = race
runpy.run_path(sys.argv[1], run_name='__main__')
`,
      join(import.meta.dir, 'encoder.py'),
      drive,
      root,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  child.stdin.write(JSON.stringify({ driveDir: drive, capture, readme: 'Fixture' }) + '\n')
  await child.stdin.end()
  const reports = new Response(child.stderr).text()
  const out = await extract(root, child.stdout)
  expect(await child.exited).toBe(0)
  expect(await reports).toContain('"completeness": "partial"')
  expect(await readFile(join(out, 'inventory.ndjson'), 'utf8')).not.toContain('secret')
  expect(await readFile(join(out, 'warnings.ndjson'), 'utf8')).toContain('source_changed')
})

test('disappearing and unreadable entries are reported while remaining files survive', async () => {
  const { root, drive } = await fixture()
  for (const name of ['vanishing', 'unreadable', 'kept'])
    await writeFile(join(drive, name), 'captured')
  const child = Bun.spawn(
    [
      'python3',
      '-c',
      `
import errno, os, runpy, sys
original_stat, original_open = os.stat, os.open
def stat_file(path, **kwargs):
    result = original_stat(path, **kwargs)
    if path == 'vanishing' and kwargs.get('dir_fd') is not None:
        os.unlink(path, dir_fd=kwargs['dir_fd'])
    return result
def open_file(path, *args, **kwargs):
    if path == 'unreadable':
        raise PermissionError(errno.EACCES, 'fixture denied')
    return original_open(path, *args, **kwargs)
os.stat, os.open = stat_file, open_file
runpy.run_path(sys.argv[1], run_name='__main__')
`,
      join(import.meta.dir, 'encoder.py'),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  child.stdin.write(JSON.stringify({ driveDir: drive, capture, readme: 'Fixture' }) + '\n')
  await child.stdin.end()
  const reports = new Response(child.stderr).text()
  const out = await extract(root, child.stdout)
  expect(await child.exited).toBe(0)
  expect(await reports).toContain('"completeness": "partial"')
  const warnings = (await readFile(join(out, 'warnings.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(warnings).toContainEqual({
    code: 'disappeared',
    path: 'drive/vanishing',
    detail: 'Filesystem entry could not be captured (errno 2)',
  })
  expect(warnings).toContainEqual({
    code: 'unreadable',
    path: 'drive/unreadable',
    detail: 'Filesystem entry could not be captured (errno 13)',
  })
  expect(await readFile(join(out, 'drive/kept'), 'utf8')).toBe('captured')
})
