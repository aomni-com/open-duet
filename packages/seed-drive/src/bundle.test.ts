import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSeedArchiveFromContent } from './bundle'

const contentDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'content')

describe('buildSeedArchive', () => {
  test('produces identical canonical tar bytes and hashes across clean builds', async () => {
    const contentDir = await mkdtemp(join(tmpdir(), 'duet-seed-content-'))
    try {
      await mkdir(join(contentDir, 'nested'))
      await writeFile(join(contentDir, 'z.txt'), 'last\n')
      await writeFile(join(contentDir, 'nested', 'a.txt'), 'first\n')

      const first = await buildSeedArchiveFromContent(contentDir)
      const second = await buildSeedArchiveFromContent(contentDir)

      expect(first).toEqual(second)
      expect(first.entries).toEqual(['drive/nested/', 'drive/nested/a.txt', 'drive/z.txt'])
      for (const metadata of readTarEntries(first.bytes)) {
        expect(metadata).toMatchObject({ uid: 0, gid: 0, mtime: 0 })
      }
    } finally {
      await rm(contentDir, { recursive: true, force: true })
    }
  })

  test('changes the archive hash when one content byte changes', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'duet-seed-content-'))
    try {
      const path = join(fixtureDir, 'file.txt')
      await writeFile(path, 'one')
      const original = await buildSeedArchiveFromContent(fixtureDir)
      await writeFile(path, 'two')
      const changed = await buildSeedArchiveFromContent(fixtureDir)

      expect(changed.sha256).not.toBe(original.sha256)
      expect(changed.bytes).not.toEqual(original.bytes)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })

  test('maps every authored content entry to one safe drive tar entry', async () => {
    const archive = await buildSeedArchiveFromContent(contentDir)

    expect(archive.entries).toEqual(
      (await listContentEntries(contentDir)).map(path => `drive/${path}`),
    )
    for (const entry of archive.entries) {
      expect(entry.startsWith('drive/')).toBe(true)
      expect(entry.startsWith('/')).toBe(false)
      expect(entry.includes('\\')).toBe(false)
      expect(entry.split('/')).not.toContain('..')
    }
  })

  test('bundles the hello app icon as a bounded 1024px PNG', async () => {
    const archive = await buildSeedArchiveFromContent(contentDir)
    const icon = readTarFile(archive.bytes, 'drive/welcome/hello-app/icon.png')

    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const header = new DataView(icon.buffer, icon.byteOffset, icon.byteLength)
    expect(header.getUint32(16)).toBe(1024)
    expect(header.getUint32(20)).toBe(1024)
    expect(icon.byteLength).toBeLessThanOrEqual(1024 * 1024)
  })

  test('ships the hello app guide without runtime store or database files', async () => {
    const archive = await buildSeedArchiveFromContent(contentDir)
    const helloEntries = archive.entries.filter(path => path.startsWith('drive/welcome/hello-app/'))

    expect(helloEntries).toContain('drive/welcome/hello-app/README.md')
    expect(
      helloEntries.filter(path =>
        /(?:\/(?:tasks|store)\.json(?:[./]|$)|\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$|-(?:wal|shm|journal)$)/i.test(
          path,
        ),
      ),
    ).toEqual([])
  })

  test('rejects content names that are unsafe in portable tar archives', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'duet-seed-content-'))
    try {
      await writeFile(join(fixtureDir, 'unsafe\\name.txt'), 'nope')
      await expect(buildSeedArchiveFromContent(fixtureDir)).rejects.toThrow(
        'Unsafe seed archive entry',
      )
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })

  test('ships bounded, structurally recognizable starter media', async () => {
    const pdf = new Uint8Array(await readFile(join(contentDir, 'welcome', 'sample.pdf')))
    const deck = new Uint8Array(await readFile(join(contentDir, 'welcome', 'deck.pptx')))
    const clip = new Uint8Array(await readFile(join(contentDir, 'welcome', 'clip.mp4')))

    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe('%PDF-')
    expect(new TextDecoder().decode(pdf.subarray(-6)).trim()).toBe('%%EOF')
    expect(pdf.byteLength).toBeGreaterThan(1024)
    expect([...deck.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect([...deck.subarray(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06])
    expect(deck.byteLength).toBeGreaterThan(5000)
    expect(new TextDecoder().decode(clip.subarray(4, 8))).toBe('ftyp')
    expect(clip.byteLength).toBeGreaterThan(1024)
    expect((await stat(join(contentDir, 'welcome', 'clip.mp4'))).size).toBeLessThanOrEqual(
      500 * 1024,
    )
  })
})

async function listContentEntries(root: string): Promise<string[]> {
  const paths: string[] = []

  async function visit(relativeDir: string): Promise<void> {
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        paths.push(`${path}/`)
        await visit(path)
      } else if (entry.isFile()) {
        paths.push(path)
      }
    }
  }

  await visit('')
  return paths.sort()
}

function readTarFile(archive: Uint8Array, expectedPath: string): Uint8Array {
  const entry = readTarEntries(archive).find(entry => entry.path === expectedPath)
  if (entry === undefined) throw new Error(`Missing tar entry: ${expectedPath}`)
  return entry.bytes
}

function readTarString(field: Uint8Array): string {
  const terminator = field.indexOf(0)
  return new TextDecoder().decode(terminator === -1 ? field : field.subarray(0, terminator))
}

function readTarEntries(
  archive: Uint8Array,
): Array<{ path: string; bytes: Uint8Array; uid: number; gid: number; mtime: number }> {
  const metadata = []
  for (let offset = 0; offset + 512 <= archive.byteLength; ) {
    const header = archive.subarray(offset, offset + 512)
    const path = readTarString(header.subarray(0, 100))
    if (path === '') break
    const octal = (start: number, length: number) =>
      Number.parseInt(readTarString(header.subarray(start, start + length)), 8)
    const size = octal(124, 12)
    metadata.push({
      path,
      bytes: archive.subarray(offset + 512, offset + 512 + size),
      uid: octal(108, 8),
      gid: octal(116, 8),
      mtime: octal(136, 12),
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return metadata
}
