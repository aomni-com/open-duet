import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const TAR_BLOCK_SIZE = 512

export interface DeterministicArchive {
  bytes: Uint8Array
  sha256: string
  entries: string[]
}

export interface DeterministicContentEntry {
  path: string
  bytes: Uint8Array | null
}

export async function buildDeterministicArchive(
  contentDir: string,
  rootPrefix: string,
): Promise<DeterministicArchive> {
  const contentEntries = await readDeterministicContentTree(contentDir)
  const prefix = rootPrefix.replace(/^\/+|\/+$/g, '')
  assertSafeEntryName(prefix)
  const tarEntries = contentEntries.map(entry => ({
    path: `${prefix}/${entry.path}`,
    bytes: entry.bytes,
  }))
  const bytes = writeTar(tarEntries)
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entries: tarEntries.map(entry => entry.path),
  }
}

export async function readDeterministicContentTree(
  contentDir: string,
): Promise<DeterministicContentEntry[]> {
  const entries: DeterministicContentEntry[] = []

  async function visit(relativeDir: string): Promise<void> {
    const directoryEntries = await readdir(join(contentDir, relativeDir), {
      withFileTypes: true,
    })
    directoryEntries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of directoryEntries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      assertSafeEntryName(relativePath)
      if (entry.isDirectory()) {
        entries.push({ path: `${relativePath}/`, bytes: null })
        await visit(relativePath)
      } else if (entry.isFile()) {
        entries.push({
          path: relativePath,
          bytes: new Uint8Array(await readFile(join(contentDir, relativePath))),
        })
      } else {
        throw new Error(`Seed content only supports files and directories: ${relativePath}`)
      }
    }
  }

  await visit('')
  return entries
}

function assertSafeEntryName(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some(part => part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe seed archive entry: ${path}`)
  }
}

function writeTar(entries: readonly DeterministicContentEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    const body = entry.bytes ?? new Uint8Array()
    const header = new Uint8Array(TAR_BLOCK_SIZE)
    writeString(header, 0, 100, entry.path)
    writeOctal(header, 100, 8, entry.bytes === null ? 0o755 : 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, body.byteLength)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = entry.bytes === null ? 0x35 : 0x30
    writeString(header, 257, 6, 'ustar')
    writeString(header, 263, 2, '00')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    writeChecksum(header, checksum)
    chunks.push(header, body)
    const padding = (TAR_BLOCK_SIZE - (body.byteLength % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
    if (padding > 0) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2))

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const archive = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }
  return archive
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > length) throw new Error(`Seed archive path is too long: ${value}`)
  target.set(bytes, offset)
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, '0')
  if (octal.length >= length) throw new Error(`Tar field overflow: ${value}`)
  writeString(target, offset, length - 1, octal)
}

function writeChecksum(target: Uint8Array, checksum: number): void {
  const octal = checksum.toString(8).padStart(6, '0')
  if (octal.length > 6) throw new Error(`Tar checksum overflow: ${checksum}`)
  writeString(target, 148, 6, octal)
  target[154] = 0
  target[155] = 0x20
}
