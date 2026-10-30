import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

export const TEN_MB_IN_BYTES = 10 * 1024 * 1024

/**
 * Writes to a log file while ensuring the file never grows beyond maxBytes.
 * Keeps the latest bytes and trims older content when needed.
 */
export class CappedLogWriter {
  private fd: number
  private size: number

  constructor(
    private filePath: string,
    private maxBytes: number = TEN_MB_IN_BYTES,
  ) {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.fd = openSync(this.filePath, 'a+')
    this.size = fstatSync(this.fd).size

    if (this.size > this.maxBytes) {
      const tail = this.readTail(this.compactionTargetBytes())
      this.rewriteWith(tail)
    }
  }

  write(message: string): void {
    let chunk = Buffer.from(message, 'utf8')
    if (chunk.length === 0) {
      return
    }

    // If a single chunk exceeds max size, keep only the latest bytes.
    if (chunk.length > this.maxBytes) {
      chunk = chunk.subarray(chunk.length - this.maxBytes)
    }

    if (this.size + chunk.length > this.maxBytes) {
      const bytesToKeep = Math.max(0, this.compactionTargetBytes() - chunk.length)
      const existingTail = bytesToKeep > 0 ? this.readTail(bytesToKeep) : Buffer.alloc(0)
      this.rewriteWith(Buffer.concat([existingTail, chunk]))
      return
    }

    const bytesWritten = writeSync(this.fd, chunk)
    this.size += bytesWritten
  }

  close(): void {
    closeSync(this.fd)
  }

  private compactionTargetBytes(): number {
    // Leave 25% headroom so reaching the cap triggers occasional compaction,
    // not a cap-sized synchronous rewrite for every subsequent log line.
    return Math.floor((this.maxBytes * 3) / 4)
  }

  private readTail(bytes: number): Buffer {
    if (bytes <= 0 || this.size === 0) {
      return Buffer.alloc(0)
    }

    const length = Math.min(bytes, this.size)
    const buffer = Buffer.alloc(length)
    const start = this.size - length

    readSync(this.fd, buffer, 0, length, start)
    return buffer
  }

  private rewriteWith(buffer: Buffer): void {
    closeSync(this.fd)
    this.fd = openSync(this.filePath, 'r+')
    ftruncateSync(this.fd, 0)
    if (buffer.length > 0) {
      writeSync(this.fd, buffer, 0, buffer.length, 0)
    }
    closeSync(this.fd)
    this.fd = openSync(this.filePath, 'a+')
    this.size = buffer.length
  }
}
