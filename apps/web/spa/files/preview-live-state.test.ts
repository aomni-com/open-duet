import { expect, test } from 'bun:test'

import type { DirectoryEntry, Result, VersionedFile } from './lib/types'
import {
  acceptLocalTextSave,
  acceptRemoteTextSnapshot,
  autosaveWanted,
  createPreviewSnapshotLoader,
  createTextDraft,
  documentSaveStatus,
  editTextDraft,
  isTextDraftDirty,
  isPreconditionFailedError,
  liveMutationsUnavailable,
  markTextSaveConflict,
  previewSourceDescriptor,
  reloadLatestTextDraft,
  resolveRejectedSave,
  supportsLivePreviewRefresh,
} from './preview-live-state'
import { EDITABLE_PREVIEW_MODE } from './preview-presentation'

const versionedText = (text: string, etag: string | null): VersionedFile => ({
  data: new TextEncoder().encode(text),
  etag,
  contentType: 'text/plain',
  size: text.length,
})

test('text draft initializes from the accepted snapshot baseline', () => {
  const draft = createTextDraft(versionedText('hello', '"v1"'))

  expect(draft).toEqual({
    text: 'hello',
    baselineText: 'hello',
    baselineEtag: '"v1"',
    conflict: false,
  })
  expect(isTextDraftDirty(draft)).toBe(false)
})

test('a clean draft adopts a changed remote ETag and bytes', () => {
  const initial = createTextDraft(versionedText('before', '"v1"'))

  const updated = acceptRemoteTextSnapshot(initial, versionedText('after', '"v2"'))

  expect(updated).toEqual({
    text: 'after',
    baselineText: 'after',
    baselineEtag: '"v2"',
    conflict: false,
  })
  expect(isTextDraftDirty(updated)).toBe(false)
})

test('remote divergence checks dirtiness at commit and preserves a newly typed draft', () => {
  const initial = createTextDraft(versionedText('before', '"v1"'))
  const typedWhileRefreshWasPending = editTextDraft(initial, 'my unsaved words')

  const diverged = acceptRemoteTextSnapshot(
    typedWhileRefreshWasPending,
    versionedText('remote words', '"v2"'),
  )

  expect(diverged).toEqual({
    text: 'my unsaved words',
    baselineText: 'before',
    baselineEtag: '"v1"',
    conflict: true,
  })
  expect(isTextDraftDirty(diverged)).toBe(true)
})

test('a new ETag over identical bytes is identity churn, never a conflict', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')

  // The drive's ETag carries the inode and ctime, so an atomic rewrite, a
  // metadata touch or a sync round trip mints a new identity for bytes nobody
  // changed. The draft adopts that identity and keeps the words being typed.
  const churned = acceptRemoteTextSnapshot(dirty, versionedText('before', '"v2"'))

  expect(churned).toEqual({
    text: 'typing',
    baselineText: 'before',
    baselineEtag: '"v2"',
    conflict: false,
  })
  expect(isTextDraftDirty(churned)).toBe(true)
})

test('the same ETag is a no-op even when the draft is dirty', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')

  const unchanged = acceptRemoteTextSnapshot(dirty, versionedText('ignored', '"v1"'))

  expect(unchanged).toBe(dirty)
  expect(unchanged.conflict).toBe(false)
})

test('autosave wants a dirty draft, and stands down for conflicts, flights and outages', () => {
  const clean = createTextDraft(versionedText('before', '"v1"'))
  const dirty = editTextDraft(clean, 'typing')
  const ready = { draft: dirty, saving: false, mutationsUnavailable: false }

  expect(autosaveWanted(ready)).toBe(true)
  expect(autosaveWanted({ ...ready, draft: clean })).toBe(false)
  expect(autosaveWanted({ ...ready, draft: null })).toBe(false)
  // A conflict is the reader's decision to make; autosave must never answer it
  // for them by writing over the other version.
  expect(autosaveWanted({ ...ready, draft: markTextSaveConflict(dirty) })).toBe(false)
  expect(autosaveWanted({ ...ready, saving: true })).toBe(false)
  expect(autosaveWanted({ ...ready, mutationsUnavailable: true })).toBe(false)
  // Text the drive already refused is not retried on a timer: an autosave that
  // reschedules itself after every failure is a write every 800ms forever.
  expect(autosaveWanted({ ...ready, refusedText: 'typing' })).toBe(false)
  expect(autosaveWanted({ ...ready, refusedText: 'older words' })).toBe(true)
})

test('the save status reads the draft, with the conflict ahead of the flight', () => {
  const clean = createTextDraft(versionedText('before', '"v1"'))
  const dirty = editTextDraft(clean, 'typing')

  expect(documentSaveStatus({ draft: null, saving: false })).toBe('none')
  expect(documentSaveStatus({ draft: clean, saving: false })).toBe('saved')
  expect(documentSaveStatus({ draft: dirty, saving: false })).toBe('unsaved')
  expect(documentSaveStatus({ draft: dirty, saving: true })).toBe('saving')
  expect(documentSaveStatus({ draft: markTextSaveConflict(dirty), saving: true })).toBe('conflict')
})

test('live conflict mutations wait until the remote identity is known again', () => {
  expect(liveMutationsUnavailable('ready')).toBe(false)
  expect(liveMutationsUnavailable('reconnecting')).toBe(true)
  expect(liveMutationsUnavailable('missing')).toBe(true)
})

test('symlink previews remain one-shot because their stat identity is intentionally null', () => {
  expect(
    supportsLivePreviewRefresh({
      type: 'symlink',
    }),
  ).toBe(false)
  expect(
    supportsLivePreviewRefresh({
      type: 'file',
    }),
  ).toBe(true)
})

test('Reload latest adopts the already accepted remote bytes and clears conflict', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')
  const conflicted = acceptRemoteTextSnapshot(dirty, versionedText('latest', '"v2"'))

  expect(conflicted.conflict).toBe(true)
  const reloaded = reloadLatestTextDraft(versionedText('latest', '"v2"'))

  expect(reloaded).toEqual({
    text: 'latest',
    baselineText: 'latest',
    baselineEtag: '"v2"',
    conflict: false,
  })
  expect(isTextDraftDirty(reloaded)).toBe(false)
})

test('a successful local save establishes the current draft as the new baseline', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'replacement')
  const conflicted = acceptRemoteTextSnapshot(dirty, versionedText('remote', '"v2"'))

  const saved = acceptLocalTextSave(conflicted, 'replacement', '"saved"')

  expect(saved).toEqual({
    text: 'replacement',
    baselineText: 'replacement',
    baselineEtag: '"saved"',
    conflict: false,
  })
  expect(isTextDraftDirty(saved)).toBe(false)
})

test('words typed while a save was in flight stay unsaved after it lands', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'first sentence')
  const keptTyping = editTextDraft(dirty, 'first sentence, second sentence')

  // Only 'first sentence' reached the drive, so only 'first sentence' is the
  // baseline — the rest is still owed a write.
  const saved = acceptLocalTextSave(keptTyping, 'first sentence', '"v2"')

  expect(saved).toEqual({
    text: 'first sentence, second sentence',
    baselineText: 'first sentence',
    baselineEtag: '"v2"',
    conflict: false,
  })
  expect(isTextDraftDirty(saved)).toBe(true)
})

test('a marked conflict stays latched through edits and remote divergence until reload', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')

  const conflicted = markTextSaveConflict(dirty)
  const typedAgain = editTextDraft(conflicted, 'typing again')
  const reverted = editTextDraft(typedAgain, 'before')
  const stillLatched = acceptRemoteTextSnapshot(reverted, versionedText('latest', '"v2"'))
  const reset = reloadLatestTextDraft(versionedText('latest', '"v2"'))

  expect(typedAgain.conflict).toBe(true)
  expect(typedAgain.text).toBe('typing again')
  expect(stillLatched).toEqual({ ...reverted, conflict: true })
  expect(reset.conflict).toBe(false)
})

test('a rejected write whose bytes still match the baseline retries against the fresh identity', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')

  const resolution = resolveRejectedSave(dirty, versionedText('before', '"v2"'))

  expect(resolution).toEqual({ kind: 'retry', ifMatch: '"v2"' })
})

test('a rejected write settles when the file already holds the words being typed', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')

  expect(resolveRejectedSave(dirty, versionedText('typing', '"v2"'))).toEqual({
    kind: 'settled',
    etag: '"v2"',
  })
})

test('a rejected write is a conflict only once the remote content actually moved', () => {
  const dirty = editTextDraft(createTextDraft(versionedText('before', '"v1"')), 'typing')

  expect(resolveRejectedSave(dirty, versionedText('somebody else wrote this', '"v2"'))).toEqual({
    kind: 'conflict',
  })
})

test('precondition failures require structural 412 status and code, never message matching', () => {
  const typed = Object.assign(new Error('opaque transport detail'), {
    status: 412,
    code: 'precondition_failed',
  })

  expect(isPreconditionFailedError(typed)).toBe(true)
  expect(isPreconditionFailedError(new Error('precondition_failed'))).toBe(false)
  expect(
    isPreconditionFailedError(
      Object.assign(new Error('wrong status'), { status: 409, code: 'precondition_failed' }),
    ),
  ).toBe(false)
  expect(
    isPreconditionFailedError(
      Object.assign(new Error('wrong code'), { status: 412, code: 'other' }),
    ),
  ).toBe(false)
})

test('live source descriptors carry the opaque ETag in URL identity and renderer key', () => {
  const calls: Array<{ path: string; version?: string | number }> = []
  const provider = {
    downloadUrl: (path: string, options: { version?: string | number } = {}) => {
      calls.push({ path, ...options })
      return options.version === undefined
        ? `/raw${path}`
        : `/raw${path}?v=${encodeURIComponent(String(options.version))}`
    },
  }

  for (const path of ['/image.png', '/brief.pdf', '/clip.mp4', '/song.mp3']) {
    const source = previewSourceDescriptor(provider, path, '"opaque/etag?one"', true)
    expect(source).toEqual({
      url: `/raw${path}?v=%22opaque%2Fetag%3Fone%22`,
      key: `${path}:"opaque/etag?one"`,
    })
    expect(previewSourceDescriptor(provider, path, '"opaque/etag?one"', true)).toEqual(source)
  }
  expect(calls).toHaveLength(8)
  expect(calls.every(call => call.version === '"opaque/etag?one"')).toBe(true)
})

test('disabled and public-style sources keep the plain URL and no key churn', () => {
  const provider = { downloadUrl: (path: string) => `/public${path}?raw` }

  expect(previewSourceDescriptor(provider, '/image.png', '"v1"', false)).toEqual({
    url: '/public/image.png?raw',
  })
  expect(previewSourceDescriptor(provider, '/image.png', '"v2"', false)).toEqual({
    url: '/public/image.png?raw',
  })
})

test('snapshot loading follows presentation strategy without renderer branches', async () => {
  const calls: Array<{ kind: 'versioned' | 'range'; path: string; signal?: AbortSignal }> = []
  const provider = {
    readVersioned: async (
      path: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<Result<VersionedFile>> => {
      calls.push({ kind: 'versioned', path, signal: options.signal })
      return { success: true, data: versionedText('whole', '"text"') }
    },
    readRange: async (
      path: string,
      range: { start: number; end: number },
      options: { signal?: AbortSignal } = {},
    ): Promise<Result<VersionedFile>> => {
      expect(range).toEqual({ start: 0, end: 4095 })
      calls.push({ kind: 'range', path, signal: options.signal })
      return { success: true, data: versionedText('sniff', '"image"') }
    },
  }
  const signal = new AbortController().signal
  const load = createPreviewSnapshotLoader(provider, EDITABLE_PREVIEW_MODE)
  const textEntry: DirectoryEntry = {
    name: 'notes.md',
    path: '/notes.md',
    type: 'file',
    isDirectory: false,
    size: 5,
  }
  const imageEntry: DirectoryEntry = {
    name: 'photo.png',
    path: '/photo.png',
    type: 'file',
    isDirectory: false,
    size: 5,
  }

  expect(await load(textEntry, signal)).toMatchObject({ success: true, data: { etag: '"text"' } })
  expect(await load(imageEntry, signal)).toMatchObject({
    success: true,
    data: { etag: '"image"' },
  })
  expect(calls).toEqual([
    { kind: 'versioned', path: '/notes.md', signal },
    { kind: 'range', path: '/photo.png', signal },
  ])
})
