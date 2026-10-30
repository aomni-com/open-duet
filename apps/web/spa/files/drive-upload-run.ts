/* ============================================================================
   One drop of files, landing in the open folder.

   Lives beside the surface rather than inside it because the interesting part
   is a sequence, not a rendering, and the sequence has three rules of its own.

   It is screened before the first byte: one file over the published limit
   refuses the whole drop, because a drop is a single gesture and nobody should
   watch three uploads finish to learn something knowable when they let go of
   the mouse.

   Then files go one at a time, so the drive is never asked to hold two at once
   and progress reads against the whole drop. The first failure ends the run —
   the failure that matters here is a full drive, and every file after it would
   fail the same way, each costing another whole transfer to find that out.

   And it can be stopped. Stopping is not failing, and the outcome shape says
   so, because the person who pressed the button already knows what happened.
   ========================================================================= */
import { exceedsDriveUploadLimit, FILE_TOO_LARGE_ERROR } from '@repo/contract'

import { VmUploadError } from '../api/vm-uploads'
import { joinBrowserFilePath } from './lib/paths'
import type { IFileSystemProvider } from './lib/types'

export type DriveUploadProgress = {
  /** How many files of the drop have finished. */
  done: number
  total: number
  currentName: string
  /** How far the current file has got, 0–100. */
  percent: number
}

export type DriveUploadOutcome =
  | { ok: true }
  /* Stopping is not failing, and the shape says so: a cancelled run reaches no
     error notice and no storage-full notifier, because the person who pressed
     the button already knows what happened. `done` is what the surface has left
     to tell them — how many landed before they stopped it. */
  | { ok: false; cancelled: true; done: number }
  | { ok: false; file: File; error: Error }

export async function runDriveUpload(options: {
  files: readonly File[]
  folderPath: string
  provider: Pick<IFileSystemProvider, 'upload'>
  onProgress(state: DriveUploadProgress): void
  signal?: AbortSignal
}): Promise<DriveUploadOutcome> {
  /* Screened before the first byte, and the whole drop goes with the one file
     that is too big. A drop is a single gesture: uploading three files and
     stopping on the fourth would make somebody watch minutes of progress to
     learn what was knowable when they let go of the mouse. The refusal carries
     the code the VM would have sent, so the surface maps one reason instead of
     telling client and server failures apart. */
  const oversize = options.files.find(file => exceedsDriveUploadLimit(file.size))
  if (oversize !== undefined) {
    return {
      ok: false,
      file: oversize,
      error: new VmUploadError(413, FILE_TOO_LARGE_ERROR),
    }
  }
  /* Read through a call rather than a property, because a signal is mutable and
     narrowing it once would let the compiler believe every later check. */
  const stopped = () => options.signal?.aborted === true
  const total = options.files.length
  for (const [done, file] of options.files.entries()) {
    /* Between files is this loop's to decide; inside one is the provider's,
       which hands the signal to the transport. Checking here as well is what
       stops the next file starting after the button was pressed. */
    if (stopped()) return { ok: false, cancelled: true, done }
    const report = (percent: number) =>
      options.onProgress({ done, total, currentName: file.name, percent })
    report(0)
    const result = await options.provider
      .upload(joinBrowserFilePath(options.folderPath, file.name), file, {
        onProgress: report,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      .catch((error: unknown) => ({ success: false as const, error: asError(error) }))
    if (!result.success) {
      if (stopped()) return { ok: false, cancelled: true, done }
      return { ok: false, file, error: result.error }
    }
  }
  return { ok: true }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
