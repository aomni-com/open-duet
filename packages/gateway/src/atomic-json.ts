import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface AtomicJsonOperations {
  mkdir(path: string): void
  open(path: string, flags: 'wx' | 'a' | 'r', mode?: number): number
  write(fileDescriptor: number, value: string): void
  fsync(fileDescriptor: number): void
  close(fileDescriptor: number): void
  rename(from: string, to: string): void
  remove(path: string): void
}

export const defaultAtomicJsonOperations: AtomicJsonOperations = {
  mkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  },
  open(path, flags, mode) {
    return openSync(path, flags, mode)
  },
  /**
   * `writeSync` in a loop, never `writeFileSync`: on Linux, Bun 1.3.14's
   * `writeFileSync(fd, string)` follows a write of 2 MiB or more to an
   * O_APPEND descriptor with an equal-length run of NUL bytes, leaving the file
   * exactly twice the size it was given and the records around the zeros
   * unreadable. A single agent event carrying an image or a large tool output
   * clears 2 MiB on its own, so journals hit this in normal use. macOS is
   * unaffected, which is why no local run can show it. The loop is correct on
   * both, and finishing a short write is the descriptor contract anyway.
   */
  write(fileDescriptor, value) {
    const payload = Buffer.from(value, 'utf8')
    let written = 0
    while (written < payload.length) {
      written += writeSync(fileDescriptor, payload, written, payload.length - written)
    }
  },
  fsync(fileDescriptor) {
    fsyncSync(fileDescriptor)
  },
  close(fileDescriptor) {
    closeSync(fileDescriptor)
  },
  rename(from, to) {
    renameSync(from, to)
  },
  remove(path) {
    rmSync(path, { force: true })
  },
}

export function writeAtomicJson(
  path: string,
  value: unknown,
  operations: AtomicJsonOperations = defaultAtomicJsonOperations,
): void {
  const directory = dirname(path)
  operations.mkdir(directory)
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  let fileDescriptor: number | null = null
  try {
    fileDescriptor = operations.open(temporary, 'wx', 0o600)
    operations.write(fileDescriptor, `${JSON.stringify(value)}\n`)
    operations.fsync(fileDescriptor)
    operations.close(fileDescriptor)
    fileDescriptor = null
    operations.rename(temporary, path)
    const directoryDescriptor = operations.open(directory, 'r')
    try {
      operations.fsync(directoryDescriptor)
    } finally {
      operations.close(directoryDescriptor)
    }
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        operations.close(fileDescriptor)
      } catch {
        // Preserve the operation that made the commit fail.
      }
    }
    try {
      operations.remove(temporary)
    } catch {
      // Preserve the operation that made the commit fail.
    }
    throw error
  }
}
