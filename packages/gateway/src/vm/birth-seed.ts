import {
  copyFile,
  lstat,
  readlink,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import { isPathInside } from '@repo/contract'

/** The tar decoder is used only for immutable birth seeds. */
export async function extractBirthSeed(archive: Uint8Array, restoreRoot: string): Promise<void> {
  const entries = listTarEntries(archive)
  assertSafeTarEntries(entries)
  neutralizeHardlinkEntries(archive, entries)
  const archivePath = resolve(restoreRoot, 'seed.tar')
  await writeFile(archivePath, archive, { mode: 0o600 })
  const proc = Bun.spawn(['tar', '-C', restoreRoot, '-xf', archivePath], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`seed restore failed: ${stderr}`)
  await materializeHardlinkCopies(restoreRoot, entries)
  await assertExtractedTreeSafe(restoreRoot)
}

interface TarEntry {
  /** Effective name after pax `path` / GNU 'L' long-name override. */
  name: string
  typeflag: string
  /** Effective link target after pax `linkpath` / GNU 'K' long-link override. */
  linkname: string
  size: number
  headerOffset: number
  /** This entry's own pax records ('x'/'g' carriers only). */
  pax: Record<string, string>
}

function listTarEntries(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let pendingPax: Record<string, string> | null = null
  let pendingLongName: string | null = null
  let pendingLongLink: string | null = null
  for (let offset = 0; offset + 512 <= archive.byteLength; ) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (!archive.subarray(offset).every(byte => byte === 0)) {
        throw new Error('archive restore rejected malformed tar trailer')
      }
      return entries
    }
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const rawName = prefix.length > 0 ? `${prefix}/${name}` : name
    const typeflag = String.fromCharCode(header[156] ?? 0).replace('\0', '')
    const size = parseTarOctal(header, 124, 12)
    if (rawName.length === 0 || typeflag.length > 1) {
      throw new Error('archive restore rejected malformed tar entry')
    }
    if (offset + 512 + size > archive.byteLength) {
      throw new Error(`archive restore rejected truncated entry: ${rawName}`)
    }
    const body = archive.subarray(offset + 512, offset + 512 + size)
    if (typeflag === 'x' || typeflag === 'g') {
      const pax = parsePaxRecords(body)
      entries.push({ name: rawName, typeflag, linkname: '', size, headerOffset: offset, pax })
      if (typeflag === 'x') pendingPax = pax
    } else if (typeflag === 'L' || typeflag === 'K') {
      // GNU long-name / long-linkname carriers: the VM emitter is GNU tar in
      // its default (gnu) format, which uses these for any path or link
      // target over 100 bytes (routine in node_modules).
      const nul = body.indexOf(0)
      const value = new TextDecoder().decode(nul === -1 ? body : body.subarray(0, nul))
      entries.push({ name: rawName, typeflag, linkname: '', size, headerOffset: offset, pax: {} })
      if (typeflag === 'L') pendingLongName = value
      else pendingLongLink = value
    } else {
      const effectiveName = pendingPax?.path ?? pendingLongName ?? rawName
      const effectiveLink = pendingPax?.linkpath ?? pendingLongLink ?? tarString(header, 157, 100)
      if (effectiveName.length === 0) {
        throw new Error('archive restore rejected malformed tar entry')
      }
      entries.push({
        name: effectiveName,
        typeflag,
        linkname: effectiveLink,
        size,
        headerOffset: offset,
        pax: {},
      })
      pendingPax = null
      pendingLongName = null
      pendingLongLink = null
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!archive.subarray(Math.floor(archive.byteLength / 512) * 512).every(byte => byte === 0)) {
    throw new Error('archive restore rejected malformed tar trailer')
  }
  return entries
}

const ALLOWED_TYPEFLAGS = new Set(['', '0', '1', '2', '5', 'x', 'g', 'L', 'K'])

function assertSafeTarEntries(entries: TarEntry[]): void {
  const symlinkNames = new Set<string>()
  for (const entry of entries) {
    // Device/fifo/socket/sparse and anything else exotic stays rejected.
    if (!ALLOWED_TYPEFLAGS.has(entry.typeflag)) {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
    assertContainedPath(entry.name, entry.name)
    if (entry.pax.path !== undefined) assertContainedPath(entry.pax.path, entry.name)
    // A pax size override would desync this validator's record walk from the
    // extracting tar's — reject the parser differential outright.
    if (entry.pax.size !== undefined) {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
    if (entry.typeflag === 'g' && entry.pax.linkpath !== undefined) {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
    const isFileSystemEntry =
      entry.typeflag === '' ||
      entry.typeflag === '0' ||
      entry.typeflag === '1' ||
      entry.typeflag === '2' ||
      entry.typeflag === '5'
    if (!isFileSystemEntry) continue
    // Never materialize a path through a symlink from the same archive: a
    // link-typed parent would let a later entry escape the restore root.
    // Containment is lexical — links themselves are stored verbatim, never
    // followed.
    if (pathTraversesName(entry.name, symlinkNames)) {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
    if (entry.typeflag === '2') {
      // Symlink: target stored verbatim — absolute, escaping, and dangling
      // targets are all legal because restore never follows them.
      if (entry.linkname.length === 0 || entry.size !== 0) {
        throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
      }
      symlinkNames.add(entry.name)
    } else if (entry.typeflag === '1') {
      // Hardlink: references an in-archive path, so that path must itself be
      // contained and must not route through an in-archive symlink (the
      // deferred copy pass reads it from disk).
      if (entry.linkname.length === 0 || entry.size !== 0) {
        throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
      }
      assertContainedPath(entry.linkname, entry.name)
      if (pathTraversesName(entry.linkname, symlinkNames)) {
        throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
      }
    } else if (entry.typeflag === '5' && entry.size !== 0) {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
  }
}

function assertContainedPath(path: string, entryName: string): void {
  const parts = path.split('/').filter(part => part.length > 0)
  if (path.startsWith('/') || parts.some(part => part === '..')) {
    throw new Error(`archive restore rejected unsafe entry: ${entryName}`)
  }
}

/** True when any proper path prefix of `path` is one of `names`. */
function pathTraversesName(path: string, names: Set<string>): boolean {
  if (names.size === 0) return false
  const parts = path.split('/').filter(part => part.length > 0 && part !== '.')
  let prefix = ''
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix.length === 0 ? (parts[i] as string) : `${prefix}/${parts[i]}`
    if (names.has(prefix)) return true
  }
  return false
}

/**
 * Rewrite every hardlink entry into an empty regular-file entry in place, so
 * the extracting tar creates a placeholder (with the entry's mode, at the
 * entry's path) instead of a hardlink. `materializeHardlinkCopies` fills the
 * content in afterwards. This also makes link-before-target archives extract
 * cleanly — tar never sees a link to a not-yet-extracted file.
 */
function neutralizeHardlinkEntries(archive: Uint8Array, entries: TarEntry[]): void {
  for (const entry of entries) {
    if (entry.typeflag !== '1') continue
    archive[entry.headerOffset + 156] = 0x30 // '0' — regular file
    rewriteHeaderChecksum(archive, entry.headerOffset)
  }
}

function rewriteHeaderChecksum(archive: Uint8Array, headerOffset: number): void {
  let sum = 0
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (archive[headerOffset + i] ?? 0)
  }
  const octal = sum.toString(8).padStart(6, '0')
  for (let i = 0; i < 6; i++) {
    archive[headerOffset + 148 + i] = octal.charCodeAt(i)
  }
  archive[headerOffset + 154] = 0
  archive[headerOffset + 155] = 0x20
}

/**
 * Deferred final pass: give every (neutralized) hardlink entry the content of
 * its in-archive target — a content copy, never a shared inode (MAP-SYNC
 * Q14). Chains of hardlinks resolve to their terminal entry so archive order
 * never matters; a hardlink to a symlink copies the symlink itself.
 */
async function materializeHardlinkCopies(restoreRoot: string, entries: TarEntry[]): Promise<void> {
  const hardlinks = entries.filter(entry => entry.typeflag === '1')
  if (hardlinks.length === 0) return
  const byName = new Map(hardlinks.map(entry => [entry.name, entry]))
  const rootReal = await realpath(restoreRoot)
  for (const entry of hardlinks) {
    let sourceName = entry.linkname
    const seen = new Set([entry.name])
    while (byName.has(sourceName)) {
      if (seen.has(sourceName)) {
        throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
      }
      seen.add(sourceName)
      sourceName = (byName.get(sourceName) as TarEntry).linkname
    }
    const source = resolve(rootReal, sourceName)
    const target = resolve(rootReal, entry.name)
    if (!isPathInside(rootReal, source) || !isPathInside(rootReal, target)) {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
    const sourceInfo = await lstat(source).catch(() => null)
    if (sourceInfo === null) {
      throw new Error(`archive restore rejected hardlink to missing target: ${entry.name}`)
    }
    const targetInfo = await lstat(target).catch(() => null)
    if (targetInfo !== null && !targetInfo.isFile()) {
      await rm(target, { force: true })
    }
    if (sourceInfo.isSymbolicLink()) {
      await rm(target, { force: true })
      await symlink(await readlink(source), target)
    } else if (sourceInfo.isFile()) {
      await copyFile(source, target)
    } else {
      throw new Error(`archive restore rejected unsafe entry: ${entry.name}`)
    }
  }
}

function parsePaxRecords(body: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(body)
  const records: Record<string, string> = {}
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space === -1) throw new Error('archive restore rejected malformed pax record')
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) {
      throw new Error('archive restore rejected malformed pax record')
    }
    const record = text.slice(space + 1, offset + length).replace(/\n$/, '')
    const separator = record.indexOf('=')
    if (separator === -1) throw new Error('archive restore rejected malformed pax record')
    records[record.slice(0, separator)] = record.slice(separator + 1)
    offset += length
  }
  return records
}

/**
 * lstat walk: symlinks are legal entries (their targets stay verbatim and are
 * never followed — dangling and escaping targets included); everything
 * followable must resolve inside the restore root; anything that is neither
 * file, directory, nor symlink is rejected.
 */
async function assertExtractedTreeSafe(root: string): Promise<void> {
  const rootReal = await realpath(root)
  async function visit(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error(`archive restore rejected unsafe entry: ${path}`)
    }
    const targetReal = await realpath(path)
    if (!isPathInside(rootReal, targetReal)) {
      throw new Error(`archive restore rejected unsafe entry: ${path}`)
    }
    if (!info.isDirectory()) return
    for (const entry of await readdir(path)) {
      await visit(resolve(path, entry))
    }
  }
  await visit(rootReal)
}

function tarString(header: Uint8Array, start: number, length: number): string {
  const end = header.indexOf(0, start)
  const sliceEnd = end === -1 || end > start + length ? start + length : end
  return new TextDecoder().decode(header.subarray(start, sliceEnd))
}

function parseTarOctal(header: Uint8Array, start: number, length: number): number {
  const raw = header.subarray(start, start + length)
  if ((raw[0] ?? 0) & 0x80)
    throw new Error('archive restore rejected unsupported tar size encoding')
  const value = tarString(header, start, length).trim()
  if (value.length === 0) return 0
  if (!/^[0-7]+$/.test(value)) throw new Error('archive restore rejected malformed tar size')
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('archive restore rejected malformed tar size')
  return parsed
}
