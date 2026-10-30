import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { MAX_TRAIN_URLS, serializeScrapedUrlFrontmatter } from '@repo/contract'

import { agentUploadScope, ROOT_UPLOAD_SCOPE, type UploadScope } from '../auth/upload-scope'
import {
  createUploadsStore as createUploadsStoreFactory,
  UploadStoreError,
  type UploadsStore,
} from './uploads-store'

const createUploadsStore = (options: {
  uploadsDir: string
  tempDir: string
  capBytes: number
  maxFiles: number
}) => {
  const trainDir = dirname(options.uploadsDir)
  if (options.tempDir !== join(trainDir, 'temp')) throw new Error('invalid test upload layout')
  return createUploadsStoreFactory({
    trainDir,
    capBytes: options.capBytes,
    maxFiles: options.maxFiles,
  }).forScope(ROOT_UPLOAD_SCOPE)
}

let root: string

async function listUploads(store: UploadsStore) {
  const page = await store.list({ limit: 100 })
  return { files: page.items, totalBytes: page.meta.totalBytes }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-uploads-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('uploads store', () => {
  test('pages the committed filename index without draining the next page', async () => {
    const store = createUploadsStore({
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: join(root, 'train', 'temp'),
      capBytes: 100,
      maxFiles: 200,
    })
    await Promise.all([
      store.put('c.bin', streamBytes([3])),
      store.put('a.bin', streamBytes([1])),
      store.put('b.bin', streamBytes([2])),
    ])

    const first = await store.list({ limit: 2 })
    expect(first.items.map(file => file.filename)).toEqual(['a.bin', 'b.bin'])
    expect(first.meta).toEqual({ totalBytes: 3, fileCount: 3 })
    expect(first.nextCursor).toBeString()

    const second = await store.list({ cursor: first.nextCursor!, limit: 2 })
    expect(second.items.map(file => file.filename)).toEqual(['c.bin'])
    expect(second.nextCursor).toBeNull()
  })

  test('cursor order distinguishes canonically equivalent Unicode filenames', async () => {
    const store = createUploadsStore({
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: join(root, 'train', 'temp'),
      capBytes: 100,
      maxFiles: 200,
    })
    await Promise.all([
      store.put('\u00e9.bin', streamBytes([1])),
      store.put('e\u0301.bin', streamBytes([2])),
    ])

    const first = await store.list({ limit: 1 })
    const second = await store.list({ cursor: first.nextCursor!, limit: 1 })
    expect([...first.items, ...second.items].map(file => file.filename).sort()).toEqual([
      'e\u0301.bin',
      '\u00e9.bin',
    ])
    expect(second.nextCursor).toBeNull()
  })

  test('accepts exactly the byte cap and rejects the next byte', async () => {
    const uploadsDir = join(root, 'train', 'uploads')
    const store = createUploadsStore({
      uploadsDir,
      tempDir: join(root, 'train', 'temp'),
      capBytes: 4,
      maxFiles: 200,
    })

    await store.put('exact.bin', streamBytes([0, 1, 254, 255]), 4)

    expect(new Uint8Array(await readFile(join(uploadsDir, 'root', 'exact.bin')))).toEqual(
      new Uint8Array([0, 1, 254, 255]),
    )
    expect(await listUploads(store)).toMatchObject({
      totalBytes: 4,
      files: [{ filename: 'exact.bin', size: 4 }],
    })
    expect(store.put('extra.bin', streamBytes([1]), 1)).rejects.toEqual(
      new UploadStoreError('quota_exceeded', 413),
    )
  })

  test('reserves streamed bytes so concurrent near-cap uploads cannot both commit', async () => {
    const store = createUploadsStore({
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: join(root, 'train', 'temp'),
      capBytes: 6,
      maxFiles: 200,
    })

    const results = await Promise.allSettled([
      store.put('a.bin', streamBytes([1, 2, 3, 4])),
      store.put('b.bin', streamBytes([5, 6, 7, 8])),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'quota_exceeded', status: 413 },
    })
    expect((await listUploads(store)).totalBytes).toBe(4)
  })

  test('atomically caps staged website sources while allowing an existing source to refresh', async () => {
    const store = createUploadsStore({
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: join(root, 'train', 'temp'),
      capBytes: 1_000_000,
      maxFiles: 200,
    })
    const uploads = Array.from({ length: MAX_TRAIN_URLS + 1 }, (_, index) => {
      const url = `https://example.com/source-${index}`
      const markdown = serializeScrapedUrlFrontmatter(
        {
          url,
          title: `Source ${index}`,
          scrapedAt: '2026-07-28T00:00:00.000Z',
        },
        `# Source ${index}`,
      )
      return store.putUrl(`source-${index}.md`, streamText(markdown), url)
    })

    const results = await Promise.allSettled(uploads)

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(MAX_TRAIN_URLS)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'too_many_urls', status: 413 },
    })
    expect((await listUploads(store)).files.filter(file => file.url !== undefined)).toHaveLength(
      MAX_TRAIN_URLS,
    )

    const existing = (await listUploads(store)).files.find(file => file.url !== undefined)!
    const refreshed = serializeScrapedUrlFrontmatter(
      {
        url: existing.url!,
        title: 'Refreshed source',
        scrapedAt: '2026-07-28T01:00:00.000Z',
      },
      '# Refreshed',
    )
    await expect(
      store.putUrl(existing.filename, streamText(refreshed), existing.url!),
    ).resolves.toMatchObject({ filename: existing.filename })
    expect((await listUploads(store)).files.filter(file => file.url !== undefined)).toHaveLength(
      MAX_TRAIN_URLS,
    )
  })

  test('accounts quota independently and snapshot-moves only the selected scope', async () => {
    const factory = createUploadsStoreFactory({
      trainDir: join(root, 'train'),
      capBytes: 4,
      maxFiles: 2,
    })
    const storeA = factory.forScope(agentUploadScope('anchor-a'))
    const storeB = factory.forScope(agentUploadScope('anchor-b'))

    await Promise.all([
      storeA.put('a.bin', streamBytes([1, 2, 3, 4]), 4),
      storeB.put('b.bin', streamBytes([5, 6, 7, 8]), 4),
    ])
    await expect(storeA.put('over.bin', streamBytes([9]), 1)).rejects.toMatchObject({
      code: 'quota_exceeded',
      status: 413,
    })

    const snapshotDir = join(root, 'train', 'jobs', 'anchor-a', 'job-1')
    await mkdir(join(root, 'train', 'jobs', 'anchor-a'), { recursive: true })
    await storeA.snapshotMove(snapshotDir)

    expect(await readFile(join(snapshotDir, 'a.bin'))).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(await listUploads(storeA)).toEqual({ files: [], totalBytes: 0 })
    expect(await listUploads(storeB)).toMatchObject({
      totalBytes: 4,
      files: [{ filename: 'b.bin', size: 4 }],
    })
  })

  test('rejects an unsafe anchor id before constructing a scoped inbox path', () => {
    const factory = createUploadsStoreFactory({
      trainDir: join(root, 'train'),
      capBytes: 4,
      maxFiles: 2,
    })

    expect(() => factory.forScope({ kind: 'agent', anchorId: '../escape' } as UploadScope)).toThrow(
      'Invalid agent anchor id',
    )
  })

  test('credits an overwrite delta and accounts bytes beyond a false Content-Length', async () => {
    const uploadsDir = join(root, 'train', 'uploads')
    const store = createUploadsStore({
      uploadsDir,
      tempDir: join(root, 'train', 'temp'),
      capBytes: 5,
      maxFiles: 200,
    })
    await store.put('same.bin', streamBytes([1, 2, 3, 4]), 1)

    await store.put('same.bin', streamBytes([8, 9]), 1)
    await store.put('other.bin', streamBytes([5, 6, 7]))

    expect(new Uint8Array(await readFile(join(uploadsDir, 'root', 'same.bin')))).toEqual(
      new Uint8Array([8, 9]),
    )
    expect(await listUploads(store)).toMatchObject({
      totalBytes: 5,
      files: [
        { filename: 'other.bin', size: 3 },
        { filename: 'same.bin', size: 2 },
      ],
    })
  })

  test('releases quota and removes the temporary file when the request stream aborts', async () => {
    const temp = join(root, 'train', 'temp')
    const store = createUploadsStore({
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: temp,
      capBytes: 4,
      maxFiles: 200,
    })
    let sent = false
    const aborted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(Uint8Array.from([1, 2]))
          return
        }
        controller.error(new Error('client aborted'))
      },
    })

    await expect(store.put('partial.bin', aborted, 4)).rejects.toThrow('client aborted')
    await store.put('complete.bin', streamBytes([1, 2, 3, 4]), 4)

    expect(await readdir(join(temp, 'root'))).toEqual([])
    expect(await listUploads(store)).toMatchObject({
      totalBytes: 4,
      files: [{ filename: 'complete.bin', size: 4 }],
    })
  })

  test('rebuilds committed-byte accounting from the inbox after restart', async () => {
    const options = {
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: join(root, 'train', 'temp'),
      capBytes: 5,
      maxFiles: 200,
    }
    await createUploadsStore(options).put('before.bin', streamBytes([1, 2, 3]), 3)

    const restarted = createUploadsStore(options)

    expect(await listUploads(restarted)).toMatchObject({
      totalBytes: 3,
      files: [{ filename: 'before.bin', size: 3 }],
    })
    await expect(restarted.put('too-large.bin', streamBytes([4, 5, 6]), 3)).rejects.toMatchObject({
      code: 'quota_exceeded',
      status: 413,
    })
  })

  test('rejects traversal, symlink replacement, and a 201st file', async () => {
    const uploadsDir = join(root, 'train', 'uploads')
    const tempDir = join(root, 'train', 'temp')
    await mkdir(join(uploadsDir, 'root'), { recursive: true })
    await writeFile(join(root, 'outside.bin'), 'outside')
    await symlink(join(root, 'outside.bin'), join(uploadsDir, 'root', 'linked.bin'))
    for (let index = 0; index < 199; index += 1) {
      await writeFile(join(uploadsDir, 'root', `file-${index}.bin`), '')
    }
    const store = createUploadsStore({ uploadsDir, tempDir, capBytes: 10, maxFiles: 200 })

    await expect(store.put('../escape.bin', streamBytes([1]), 1)).rejects.toMatchObject({
      code: 'invalid_filename',
      status: 400,
    })
    await expect(store.put('linked.bin', streamBytes([1]), 1)).rejects.toMatchObject({
      code: 'path_is_symlink',
      status: 409,
    })
    await store.put('file-199.bin', streamBytes([]), 0)
    await expect(store.put('file-200.bin', streamBytes([1]), 1)).rejects.toMatchObject({
      code: 'too_many_files',
      status: 413,
    })
    expect(await readFile(join(root, 'outside.bin'), 'utf8')).toBe('outside')
  })

  test('atomically hands off a snapshot and recreates an empty inbox', async () => {
    const uploadsDir = join(root, 'train', 'uploads')
    const store = createUploadsStore({
      uploadsDir,
      tempDir: join(root, 'train', 'temp'),
      capBytes: 10,
      maxFiles: 200,
    })
    await store.put('source.bin', streamBytes([1, 2, 3]), 3)

    const snapshotDir = join(root, 'train', 'jobs', 'job-1')
    await mkdir(join(root, 'train', 'jobs'), { recursive: true })
    await store.snapshotMove(snapshotDir)

    expect(new Uint8Array(await readFile(join(snapshotDir, 'source.bin')))).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(await listUploads(store)).toEqual({ files: [], totalBytes: 0 })
    await store.put('next.bin', streamBytes([4]), 1)
    expect(new Uint8Array(await readFile(join(uploadsDir, 'root', 'next.bin')))).toEqual(
      new Uint8Array([4]),
    )
  })

  test('does not scan beyond the bounded markdown prefix while listing', async () => {
    const store = createUploadsStore({
      uploadsDir: join(root, 'train', 'uploads'),
      tempDir: join(root, 'train', 'temp'),
      capBytes: 100_000,
      maxFiles: 200,
    })
    const markdown = [
      '---',
      'url: "https://example.com/beyond-prefix"',
      `title: ${JSON.stringify('x'.repeat(70_000))}`,
      'scrapedAt: "2026-07-15T00:00:00.000Z"',
      '---',
      'body',
    ].join('\n')
    await store.put('large.md', streamText(markdown), Buffer.byteLength(markdown))

    expect(await listUploads(store)).toMatchObject({
      files: [{ filename: 'large.md', size: Buffer.byteLength(markdown) }],
    })
    expect((await listUploads(store)).files[0]).not.toHaveProperty('url')
  })
})

function streamBytes(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes))
      controller.close()
    },
  })
}

function streamText(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
