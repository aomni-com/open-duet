import { expect, test } from 'bun:test'

import { AGENT_INPUT_IMAGE_MAX_BYTES, DRIVE_UPLOAD_MAX_BYTES } from '@repo/contract'

import type { SessionAttachmentUploader } from './session-attachments'
import {
  createSessionAttachmentDraft,
  DEFAULT_ATTACHMENT_ERROR_LABELS,
} from './session-attachments'

/** A pick the Drive will not take — one byte past the published limit. */
function oversizeFile(name: string): File {
  const file = new File([], name, { type: 'application/zip' })
  Object.defineProperty(file, 'size', { value: DRIVE_UPLOAD_MAX_BYTES + 1 })
  return file
}

class FakeUploader implements SessionAttachmentUploader {
  readonly puts: Array<{ cwd?: string; filename: string; file: File }> = []
  readonly existing = new Set<string>()
  /** Every collision probe, which is a network `stat` — so a refusal that
      reaches it has already cost a round trip it did not need. */
  readonly existsProbes: string[] = []
  readonly deletes: Array<{ cwd?: string; filename: string }> = []
  readonly mkdirs: string[] = []
  readonly moves: Array<{ source: string; destination: string }> = []

  put(
    cwd: string | undefined,
    filename: string,
    file: File,
    onProgress: (percent: number) => void,
  ) {
    this.puts.push({ cwd, filename, file })
    onProgress(100)
    return { done: Promise.resolve(), abort() {} }
  }

  async delete(cwd: string | undefined, filename: string) {
    this.deletes.push({ cwd, filename })
  }
  async exists(cwd: string | undefined, filename: string) {
    this.existsProbes.push(`${cwd ?? ''}/${filename}`)
    return this.existing.has(`${cwd ?? ''}/${filename}`)
  }
  async mkdir(path: string) {
    this.mkdirs.push(path)
  }
  async move(source: string, destination: string) {
    this.moves.push({ source, destination })
  }
}

class ControlledUploader extends FakeUploader {
  readonly requests: Array<{
    progress(percent: number): void
    resolve(): void
    reject(error?: Error): void
    aborted: boolean
  }> = []

  override put(
    cwd: string | undefined,
    filename: string,
    file: File,
    onProgress: (percent: number) => void,
  ) {
    this.puts.push({ cwd, filename, file })
    let resolve!: () => void
    let reject!: (error: Error) => void
    const done = new Promise<void>((doneResolve, doneReject) => {
      resolve = doneResolve
      reject = doneReject
    })
    const request = {
      progress: onProgress,
      resolve,
      reject: (error = new Error('upload failed')) => reject(error),
      aborted: false,
    }
    this.requests.push(request)
    return {
      done,
      abort() {
        request.aborted = true
        reject(new DOMException('Upload aborted', 'AbortError'))
      },
    }
  }
}

class ControlledMoveUploader extends FakeUploader {
  moveStarted = false
  private resolveMove!: () => void

  override async move(source: string, destination: string) {
    this.moves.push({ source, destination })
    this.moveStarted = true
    await new Promise<void>(resolve => {
      this.resolveMove = resolve
    })
  }

  finishMove() {
    this.resolveMove()
  }
}

async function waitUntilReady(draft: ReturnType<typeof createSessionAttachmentDraft>) {
  while (draft.snapshot().busy) await Bun.sleep(0)
}

test('routes inline-capable images to images and every overflow or other file to uploads', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({
    scopeCwd: 'agents/research',
    uploader,
    id: (() => {
      let next = 0
      return () => `attachment-${++next}`
    })(),
  })
  const inline = Array.from(
    { length: 5 },
    (_, index) => new File(['png'], `diagram-${index + 1}.png`, { type: 'image/png' }),
  )
  const oversized = new File([new Uint8Array(AGENT_INPUT_IMAGE_MAX_BYTES + 1)], 'large.png', {
    type: 'image/png',
  })
  const pdf = new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })

  draft.add([...inline, oversized, pdf])
  await waitUntilReady(draft)

  const payload = draft.payload()
  expect(payload.images).toHaveLength(4)
  expect(payload.images.map(image => image.mimeType)).toEqual([
    'image/png',
    'image/png',
    'image/png',
    'image/png',
  ])
  expect(payload.attachments).toEqual([
    {
      path: 'agents/research/uploads/diagram-5.png',
      name: 'diagram-5.png',
      bytes: 3,
      mimeType: 'image/png',
    },
    {
      path: 'agents/research/uploads/large.png',
      name: 'large.png',
      bytes: AGENT_INPUT_IMAGE_MAX_BYTES + 1,
      mimeType: 'image/png',
    },
    {
      path: 'agents/research/uploads/brief.pdf',
      name: 'brief.pdf',
      bytes: 3,
      mimeType: 'application/pdf',
    },
  ])
  expect(uploader.puts.map(put => put.filename)).toEqual([
    'diagram-5.png',
    'large.png',
    'brief.pdf',
  ])
})

test('stats before upload and gives colliding files stable numbered names in selection order', async () => {
  const uploader = new FakeUploader()
  uploader.existing.add('agents/research/report.pdf')
  const draft = createSessionAttachmentDraft({
    scopeCwd: 'agents/research',
    uploader,
    id: () => crypto.randomUUID(),
  })

  draft.add([
    new File(['first'], 'report.pdf', { type: 'application/pdf' }),
    new File(['second'], 'report.pdf', { type: 'application/pdf' }),
  ])
  await waitUntilReady(draft)

  expect(uploader.puts.map(put => put.filename)).toEqual(['report (2).pdf', 'report (3).pdf'])
  expect(draft.payload().attachments.map(attachment => attachment.path)).toEqual([
    'agents/research/uploads/report (2).pdf',
    'agents/research/uploads/report (3).pdf',
  ])
})

test('maps upload progress and completion into card status and the busy gate', async () => {
  const uploader = new ControlledUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })

  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  while (uploader.requests.length === 0) await Bun.sleep(0)
  expect(draft.snapshot()).toMatchObject({
    busy: true,
    items: [{ status: { label: 'Uploading · 0%' } }],
  })

  uploader.requests[0]!.progress(42)
  expect(draft.snapshot().items[0]?.status?.label).toBe('Uploading · 42%')
  uploader.requests[0]!.resolve()
  await waitUntilReady(draft)

  expect(draft.snapshot()).toMatchObject({ busy: false, items: [{ status: { label: 'Ready' } }] })
})

test('builds local image, text, and table previews before upload completion', async () => {
  const uploader = new ControlledUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([
    new File(['image'], 'logo.png', { type: 'image/png' }),
    new File(['Heading\nA short paragraph'], 'notes.txt', { type: 'text/plain' }),
    new File(['Market,Q1,Q2\nNorth,42,51'], 'metrics.csv', { type: 'text/csv' }),
  ])
  await Bun.sleep(0)

  expect(draft.snapshot().items.map(item => item.preview?.kind)).toEqual(['image', 'text', 'table'])
  expect(draft.snapshot().items[1]?.preview).toMatchObject({ text: 'Heading\nA short paragraph' })
  expect(draft.snapshot().items[2]?.preview).toMatchObject({
    rows: [
      ['Market', 'Q1', 'Q2'],
      ['North', '42', '51'],
    ],
  })
})

test('large uploaded images fall back to a file card without decoding a local preview', () => {
  const uploader = new ControlledUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([
    new File([new Uint8Array(AGENT_INPUT_IMAGE_MAX_BYTES + 1)], 'large.png', {
      type: 'image/png',
    }),
  ])

  expect(draft.snapshot().items[0]?.preview).toBeUndefined()
})

test('unsupported image formats use the same file fallback in draft and transcript', () => {
  const uploader = new ControlledUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['heic'], 'photo.heic', { type: 'image/heic' })])

  expect(draft.snapshot().items[0]?.preview).toBeUndefined()
})

test('removing a pending upload aborts it while removing a ready upload deletes it', async () => {
  const pendingUploader = new ControlledUploader()
  const pending = createSessionAttachmentDraft({
    scopeCwd: 'agents/research',
    uploader: pendingUploader,
  })
  pending.add([new File(['draft'], 'draft.pdf', { type: 'application/pdf' })])
  while (pendingUploader.requests.length === 0) await Bun.sleep(0)

  pending.remove(pending.snapshot().items[0]!)

  expect(pendingUploader.requests[0]!.aborted).toBe(true)
  expect(pending.snapshot().items).toEqual([])
  expect(pendingUploader.deletes).toEqual([])

  const readyUploader = new FakeUploader()
  const ready = createSessionAttachmentDraft({
    scopeCwd: 'agents/research',
    uploader: readyUploader,
  })
  ready.add([new File(['final'], 'final.pdf', { type: 'application/pdf' })])
  await waitUntilReady(ready)
  ready.remove(ready.snapshot().items[0]!)
  while (readyUploader.deletes.length === 0) await Bun.sleep(0)

  expect(readyUploader.deletes).toEqual([{ cwd: 'agents/research', filename: 'final.pdf' }])
})

test('keeps failed uploads busy and retries the same attachment without changing its key', async () => {
  const uploader = new ControlledUploader()
  const draft = createSessionAttachmentDraft({
    scopeCwd: undefined,
    uploader,
    id: () => 'stable-id',
  })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  while (uploader.requests.length === 0) await Bun.sleep(0)
  uploader.requests[0]!.reject()
  while (draft.snapshot().items[0]?.status?.tone !== 'danger') await Bun.sleep(0)

  expect(draft.snapshot().busy).toBe(true)
  expect(() => draft.payload()).toThrow('Attachments are not ready')
  expect(draft.snapshot().key).toBe('stable-id')

  draft.retry('stable-id')
  while (uploader.requests.length < 2) await Bun.sleep(0)
  uploader.requests[1]!.resolve()
  await waitUntilReady(draft)

  expect(draft.snapshot().key).toBe('stable-id:uploads/notes.pdf')
  expect(draft.snapshot().items[0]?.id).toBe('stable-id')
  expect(draft.payload().attachments[0]?.path).toBe('uploads/notes.pdf')
})

test('surfaces typed workspace and storage upload failures through the card and notifier', async () => {
  const uploader = new ControlledUploader()
  const errors: unknown[] = []
  const draft = createSessionAttachmentDraft({
    scopeCwd: undefined,
    uploader,
    onError: error => errors.push(error),
    errorLabels: () => ({
      ...DEFAULT_ATTACHMENT_ERROR_LABELS,
      workspace_paused: 'Workspace paused',
    }),
  })

  draft.add([new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })])
  await Bun.sleep(0)
  const failure = Object.assign(new Error('paused'), { code: 'workspace_paused' })
  uploader.requests[0]!.reject(failure)
  await Bun.sleep(0)

  expect(draft.snapshot().items[0]?.status).toEqual({
    label: 'Workspace paused',
    tone: 'danger',
  })
  expect(errors).toEqual([failure])
})

test('refuses an oversize pick without sending or even naming it', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({
    scopeCwd: undefined,
    uploader,
    errorLabels: () => ({ ...DEFAULT_ATTACHMENT_ERROR_LABELS, file_too_large: 'Over 32.0 GB' }),
  })

  draft.add([oversizeFile('sandbox-home-backup.zip')])
  await Bun.sleep(0)

  expect(draft.snapshot().items[0]?.status).toEqual({ label: 'Over 32.0 GB', tone: 'danger' })
  expect(uploader.puts).toEqual([])
  // The collision probe is a network `stat`. Refusing after it would already
  // have cost a round trip, which is why the guard sits inside `upload`.
  expect(uploader.existsProbes).toEqual([])
})

// Retry is why the guard cannot live in `add`: it re-enters `upload` directly,
// so a check at pick time would let the button start a doomed transfer.
test('retrying an oversize pick refuses again instead of sending it', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader, id: () => 'over' })

  draft.add([oversizeFile('sandbox-home-backup.zip')])
  await Bun.sleep(0)
  draft.retry('over')
  await Bun.sleep(0)

  expect(uploader.puts).toEqual([])
  expect(draft.snapshot().items[0]?.status?.tone).toBe('danger')
})

test('creates the destination folder, moves landed files, and rewrites payload paths on cwd change', async () => {
  const uploader = new FakeUploader()
  uploader.existing.add('agents/research/notes.pdf')
  const draft = createSessionAttachmentDraft({ scopeCwd: 'agents/research', uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  const researchKey = draft.snapshot().key
  draft.setScopeCwd('agents/writer')
  while (draft.snapshot().busy) await Bun.sleep(0)

  expect(uploader.mkdirs).toEqual(['agents/writer/uploads'])
  expect(uploader.moves).toEqual([
    {
      source: 'agents/research/uploads/notes (2).pdf',
      destination: 'agents/writer/uploads/notes.pdf',
    },
  ])
  expect(draft.payload().attachments[0]?.path).toBe('agents/writer/uploads/notes.pdf')
  expect(draft.snapshot().key).not.toBe(researchKey)
})

test('canonicalizes an accepted cwd alias before upload and durable payload construction', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({
    scopeCwd: 'agents/research/../writer',
    uploader,
  })

  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  expect(uploader.puts).toEqual([
    expect.objectContaining({ cwd: 'agents/writer', filename: 'notes.pdf' }),
  ])
  expect(draft.payload().attachments[0]?.path).toBe('agents/writer/uploads/notes.pdf')
})

test('removing a file during re-home deletes it from the destination after the move settles', async () => {
  const uploader = new ControlledMoveUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: 'agents/research', uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)
  const attachment = draft.snapshot().items[0]!

  draft.setScopeCwd('agents/writer')
  while (!uploader.moveStarted) await Bun.sleep(0)
  draft.remove(attachment)
  uploader.finishMove()
  while (uploader.deletes.length === 0) await Bun.sleep(0)

  expect(uploader.deletes).toEqual([{ cwd: 'agents/writer', filename: 'notes.pdf' }])
  expect(draft.snapshot().items).toEqual([])
})

test('caps the whole draft at ten files independently of the four-image inline cap', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  const images = Array.from(
    { length: 6 },
    (_, index) => new File(['png'], `image-${index}.png`, { type: 'image/png' }),
  )
  const documents = Array.from(
    { length: 6 },
    (_, index) => new File(['pdf'], `document-${index}.pdf`, { type: 'application/pdf' }),
  )

  draft.add([...images, ...documents])
  await waitUntilReady(draft)

  expect(draft.snapshot().items.map(item => item.name)).toEqual([
    'image-0.png',
    'image-1.png',
    'image-2.png',
    'image-3.png',
    'image-4.png',
    'image-5.png',
    'document-0.pdf',
    'document-1.pdf',
    'document-2.pdf',
    'document-3.pdf',
  ])
  expect(draft.payload().images).toHaveLength(4)
  expect(draft.payload().attachments).toHaveLength(6)
  expect(draft.add([new File(['extra'], 'extra.txt', { type: 'text/plain' })])).toBe(false)
  expect(draft.snapshot().items).toHaveLength(10)
})

test('commit drops the batch reference without deleting landed files', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  draft.commit()

  expect(draft.snapshot()).toEqual({ items: [], busy: false, key: '' })
  expect(draft.payload()).toEqual({ images: [], attachments: [] })
  expect(uploader.deletes).toEqual([])
})

test('discard drops the batch and best-effort deletes landed files', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: 'agents/research', uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.discard()
  await Bun.sleep(0)

  expect(draft.snapshot()).toEqual({ items: [], busy: false, key: '' })
  expect(uploader.deletes).toEqual([{ cwd: 'agents/research', filename: 'notes.pdf' }])
})

test('an unresolved submission retains landed files when its surface unmounts', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  draft.discard()
  await Bun.sleep(0)

  expect(uploader.deletes).toEqual([])
})

test('a confirmed rejection returns landed files to discard ownership', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  expect(draft.snapshot().items).toEqual([])
  draft.rejectSubmission()
  expect(draft.snapshot().items.map(item => item.name)).toEqual(['notes.pdf'])
  draft.discard()
  await Bun.sleep(0)

  expect(uploader.deletes).toEqual([{ cwd: undefined, filename: 'notes.pdf' }])
})

test('a later rejected retry cannot release paths retained by an earlier ambiguous attempt', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  draft.restoreSubmission()
  draft.beginSubmission()
  draft.rejectSubmission()
  draft.discard()
  await Bun.sleep(0)

  expect(uploader.deletes).toEqual([])
})

test('an ambiguous attempt pins its submitted path against later re-homing', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: 'agents/research', uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  // The ambiguous send's files return for the retry, which must name the same
  // paths — so a scope change after their return must not move them either.
  draft.restoreSubmission()
  draft.setScopeCwd('agents/writer')
  await Bun.sleep(0)

  expect(uploader.moves).toEqual([])
  expect(draft.payload().attachments[0]?.path).toBe('agents/research/uploads/notes.pdf')
})

test('discard cleans the final path when an in-flight upload races cancellation', async () => {
  const uploader = new ControlledUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['notes'], 'notes.pdf', { type: 'application/pdf' })])
  while (uploader.requests.length === 0) await Bun.sleep(0)

  draft.discard()
  uploader.requests[0]!.resolve()
  await Bun.sleep(0)

  expect(uploader.deletes).toEqual([{ cwd: undefined, filename: 'notes.pdf' }])
})

test('starting a send hands over exactly the batch it takes', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['sent'], 'sent.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  const sent = draft.beginSubmission()

  expect(sent.attachments.map(file => file.path)).toEqual(['uploads/sent.pdf'])
  expect(draft.snapshot().items).toEqual([])
})

test('files picked while a send is in flight belong to the next message', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['sent'], 'sent.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  draft.add([new File(['next'], 'next.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)
  expect(draft.snapshot().items.map(item => item.name)).toEqual(['next.pdf'])
  draft.commit()

  expect(draft.snapshot().items.map(item => item.name)).toEqual(['next.pdf'])
  expect(draft.payload().attachments.map(file => file.path)).toEqual(['uploads/next.pdf'])
  expect(uploader.deletes).toEqual([])
})

test('a failed send puts its files back ahead of the ones picked meanwhile', async () => {
  const uploader = new FakeUploader()
  const draft = createSessionAttachmentDraft({ scopeCwd: undefined, uploader })
  draft.add([new File(['sent'], 'sent.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)

  draft.beginSubmission()
  draft.add([new File(['next'], 'next.pdf', { type: 'application/pdf' })])
  await waitUntilReady(draft)
  draft.restoreSubmission()

  expect(draft.snapshot().items.map(item => item.name)).toEqual(['sent.pdf', 'next.pdf'])
  expect(draft.payload().attachments.map(file => file.path)).toEqual([
    'uploads/sent.pdf',
    'uploads/next.pdf',
  ])
})
