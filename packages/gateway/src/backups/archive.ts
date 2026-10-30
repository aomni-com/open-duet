import {
  BackupArchiveSummarySchema,
  BackupCaptureSchema,
  BackupWarningSchema,
  type BackupArchiveSummary,
  type BackupCapture,
  type BackupWarning,
} from '@repo/contract'

import encoder from './encoder.py' with { type: 'text' }
import readme from './recovery.md' with { type: 'text' }

export type BackupRecordEntry = {
  path: string
  body: AsyncIterable<Uint8Array>
  mode?: number
  /** Unix mtime in milliseconds. */
  mtime?: number
}
export type BackupRecord = BackupRecordEntry | BackupWarning
export type BackupArchiveProgress = BackupArchiveSummary['counts']

export function buildWorkspaceBackup(options: {
  driveDir: string
  records: AsyncIterable<BackupRecord>
  capture: BackupCapture
  signal?: AbortSignal
  onProgress?: (progress: BackupArchiveProgress) => void
}): { body: ReadableStream<Uint8Array>; completed: Promise<BackupArchiveSummary> } {
  const capture = BackupCaptureSchema.parse(options.capture)
  const child = Bun.spawn(['python3', '-u', '-c', encoder], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const controller = new AbortController()
  const abort = () => {
    controller.abort(options.signal?.reason ?? new Error('Backup cancelled'))
    child.kill()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  function nextOrAbort<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
    controller.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', cancelled, { once: true })
      // A shared pending abort promise would retain every winning chunk until cancellation.
      Promise.resolve()
        .then(() => iterator.next())
        .then(resolve, reject)
        .finally(() => {
          controller.signal.removeEventListener('abort', cancelled)
        })
    })
  }
  async function* interruptible<T>(source: AsyncIterable<T>) {
    const iterator = source[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await nextOrAbort(iterator)
        if (next.done) return
        yield next.value
      }
    } finally {
      void iterator.return?.().catch(() => {})
    }
  }
  const write = async (value: unknown) => {
    controller.signal.throwIfAborted()
    child.stdin.write(JSON.stringify(value) + '\n')
    await child.stdin.flush()
  }
  const producing = (async () => {
    await write({ driveDir: options.driveDir, capture, readme })
    for await (const record of interruptible(options.records)) {
      if ('code' in record) {
        await write(BackupWarningSchema.parse(record))
        continue
      }
      const { body, ...header } = record
      await write(header)
      for await (const chunk of interruptible(body)) {
        for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
          await write(Buffer.from(chunk.subarray(offset, offset + 64 * 1024)).toString('base64'))
        }
      }
      await write(null)
    }
    await child.stdin.end()
  })()
  void producing.catch(abort)
  let summary: BackupArchiveSummary | undefined
  let failure: string | undefined
  const reporting = (async () => {
    let pending = ''
    for await (const chunk of child.stderr) {
      pending += new TextDecoder().decode(chunk)
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        const record = JSON.parse(line)
        if (record.summary) summary = BackupArchiveSummarySchema.parse(record.summary)
        if (record.error) failure = record.error
        if (record.progress) options.onProgress?.(record.progress)
      }
      if (pending.length > 64 * 1024) throw new Error('Invalid backup encoder report')
    }
  })()
  void reporting.catch(abort)
  const completed = (async () => {
    try {
      const exit = await child.exited
      if (exit !== 0) {
        abort()
        await reporting
        throw new Error(failure ?? 'Backup encoder failed')
      }
      await producing
      await reporting
      controller.signal.throwIfAborted()
      if (!summary) throw new Error('Backup encoder did not finish')
      return summary
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  })()
  void completed.catch(() => {})
  const reader = child.stdout.getReader()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(stream) {
        try {
          const next = await reader.read()
          if (next.done) {
            await completed
            stream.close()
          } else stream.enqueue(next.value)
        } catch (error) {
          abort()
          stream.error(error)
        }
      },
      async cancel() {
        abort()
        await reader.cancel()
        await completed.catch(() => {})
      },
    },
    { highWaterMark: 1 },
  )
  return { body, completed }
}
