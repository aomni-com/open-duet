'use client'

import { useEffect, useRef, useState } from 'react'

import type { IFileSystemProvider, VersionedFile } from './lib/types'
import {
  acceptLocalTextSave,
  acceptRemoteTextSnapshot,
  AUTOSAVE_DEBOUNCE_MS,
  autosaveWanted,
  createTextDraft,
  documentSaveStatus,
  editTextDraft,
  isPreconditionFailedError,
  isTextDraftDirty,
  markTextSaveConflict,
  reloadLatestTextDraft,
  resolveRejectedSave,
  type DocumentSaveStatus,
  type TextDraft,
} from './preview-live-state'
import type { LiveFileSnapshot } from './use-live-file'

/**
 * The editable text document: the words on screen, and everything it takes to
 * keep the drive holding them.
 *
 * One owner for the whole write rail — the draft, the remote folding, the
 * debounce, the parting flush, and what a rejected write means — because those
 * are not five decisions, they are one: *whose version of this file is true
 * right now*. The pane that renders the document consumes this and holds none
 * of it; the decisions themselves are pure and live in `preview-live-state`.
 */
export interface TextDocument {
  /** The text to render, or `''` for a document that has no draft (binary). */
  text: string
  /** Two versions of this file disagree, and only the reader can settle it. */
  conflict: boolean
  status: DocumentSaveStatus
  saving: boolean
  /** A write the drive refused for a reason the reader has to see. */
  error: Error | null
  clearError(): void
  edit(text: string): void
  /** Write now. `overwrite` answers a conflict by replacing the other version. */
  save(overwrite?: boolean): Promise<void>
  /** Answer a conflict by taking the drive's version instead. */
  reloadLatest(): void
}

export interface TextDocumentOptions {
  provider: IFileSystemProvider
  /** The entry as last accepted from the drive — its path is where writes go. */
  path: string
  file: VersionedFile | null
  /** Entry size/name carrier for the snapshot a local save hands the live rail. */
  snapshotEntry: LiveFileSnapshot['entry']
  isText: boolean
  editable: boolean
  contentType: string
  /** The drive cannot be written right now (reconnecting, or the file is gone). */
  mutationsUnavailable: boolean
  live: {
    acceptLocalSave(snapshot: LiveFileSnapshot): void
    checkNow(): void
  }
}

export function useTextDocument(options: TextDocumentOptions): TextDocument {
  const { provider, path, file, isText, editable, contentType, mutationsUnavailable, live } =
    options
  const [draft, setDraft] = useState<TextDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [awaitingReload, setAwaitingReload] = useState(false)
  /* A write is in flight. Held in a ref as well as in state because two saves
     can be asked for inside one React tick — a keystroke's debounce landing as
     the reader clicks away — and the second must see the first. */
  const savingRef = useRef(false)
  /* The write this document still owes the drive, kept where a teardown can
     reach it. Assigned in an effect rather than during render so that when the
     reader opens another file, the cleanup below still sees the old file's
     unwritten words and the old file's path. */
  const owedWrite = useRef<{
    path: string
    text: string
    contentType: string
    ifMatch: string | null
  } | null>(null)
  /* Text the drive refused outright — offline, out of space, permission. The
     next keystroke asks again; a timer must not. */
  const refusedText = useRef<string | null>(null)
  /* The text a write is currently carrying, so the teardown flush does not
     send the same words a second time behind an in-flight save. */
  const writingText = useRef<string | null>(null)

  useEffect(() => {
    setAwaitingReload(false)
  }, [path])

  useEffect(() => {
    if (!isText || file === null) {
      setDraft(null)
      return
    }
    setDraft(current =>
      current === null ? createTextDraft(file) : acceptRemoteTextSnapshot(current, file),
    )
  }, [file, isText])

  useEffect(() => {
    if (!awaitingReload || file === null || draft === null) return
    if (file.etag === draft.baselineEtag) return
    setDraft(reloadLatestTextDraft(file))
    setAwaitingReload(false)
  }, [awaitingReload, draft, file])

  /**
   * Write the draft to the drive.
   *
   * A rejected precondition is not yet a conflict. The drive's ETag carries the
   * file's inode and ctime, so an atomic rewrite or a sync round trip mints a
   * new identity for bytes nobody changed — and under autosave the reader would
   * meet a "someone else edited this" banner for a file only they have touched.
   * So a rejection reads the file back first and asks what actually happened:
   * already ours, still the bytes we based on (write again against the identity
   * on disk), or genuinely moved — the only case the reader hears about.
   */
  const save = async (overwrite = false) => {
    const current = draft
    if (current === null || file === null || mutationsUnavailable) return
    if (savingRef.current) return
    // A latched conflict is the reader's question to answer — only Replace file
    // (`overwrite`) may write past it.
    if (!overwrite && (current.conflict || !isTextDraftDirty(current))) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    const text = current.text
    writingText.current = text
    const data = new TextEncoder().encode(text)
    let ifMatch = overwrite ? null : current.baselineEtag

    const accept = (etag: string | null, size: number) => {
      refusedText.current = null
      if (etag !== null) {
        live.acceptLocalSave({
          entry: { ...options.snapshotEntry, size },
          file: { data, etag, contentType, size },
        })
      }
      setDraft(latest => (latest === null ? latest : acceptLocalTextSave(latest, text, etag)))
      setAwaitingReload(false)
    }
    const conflict = () => {
      setDraft(latest => (latest === null ? latest : markTextSaveConflict(latest)))
      live.checkNow()
    }

    for (let attempt = 0; ; attempt += 1) {
      const result = await provider.write(path, data, {
        contentType,
        ...(ifMatch === null ? {} : { ifMatch }),
      })
      if (result.success) {
        accept(result.data.etag, result.data.size)
        break
      }
      if (!isPreconditionFailedError(result.error) || attempt > 0) {
        if (isPreconditionFailedError(result.error)) conflict()
        else {
          refusedText.current = text
          setError(result.error)
        }
        break
      }
      /* The identity comes from stat, never from the read's own header: the
         header is rewritable in transit, and a retry against a value the drive
         never minted can only be rejected again. */
      const [latest, identity] = await Promise.all([
        provider.readVersioned(path),
        provider.stat(path),
      ])
      if (!latest.success) {
        setError(latest.error)
        break
      }
      if (!identity.success) {
        setError(identity.error)
        break
      }
      const resolution = resolveRejectedSave(current, {
        ...latest.data,
        etag: identity.data.etag,
      })
      if (resolution.kind === 'settled') {
        accept(identity.data.etag, latest.data.size)
        break
      }
      if (resolution.kind === 'conflict') {
        conflict()
        break
      }
      ifMatch = resolution.ifMatch
    }
    savingRef.current = false
    writingText.current = null
    setSaving(false)
  }

  /* Autosave: the words are the reader's, and the drive is where they live.
     Typing settles for AUTOSAVE_DEBOUNCE_MS and the file is written; there is
     no Save to remember, and nothing to lose by not remembering it. */
  useEffect(() => {
    if (
      !editable ||
      !autosaveWanted({ draft, saving, mutationsUnavailable, refusedText: refusedText.current })
    )
      return
    const timer = window.setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    /* `save` is rebuilt every render and is deliberately not a dependency: the
       draft it closes over is the one this effect scheduled the write for. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editable, mutationsUnavailable, saving])

  useEffect(() => {
    owedWrite.current =
      editable &&
      draft !== null &&
      !draft.conflict &&
      isTextDraftDirty(draft) &&
      draft.text !== writingText.current
        ? { path, text: draft.text, contentType, ifMatch: draft.baselineEtag }
        : null
  }, [contentType, draft, editable, path])

  /* Leaving is a save. Closing the tab, hiding it, or walking to another file
     all land inside the debounce window sooner or later, and an editor that
     drops the last sentence typed before a click is worse than one that never
     autosaved at all. It still writes against the identity it was based on:
     there is no surface left to ask a question on, and a parting write must
     not be the one thing in the product that can overwrite work it never
     showed anyone. */
  useEffect(() => {
    const flush = () => {
      const owed = owedWrite.current
      if (owed === null) return
      owedWrite.current = null
      void provider.write(owed.path, new TextEncoder().encode(owed.text), {
        contentType: owed.contentType,
        ...(owed.ifMatch === null ? {} : { ifMatch: owed.ifMatch }),
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [provider])

  const reloadLatest = () => {
    if (file === null || draft === null || mutationsUnavailable) return
    if (file.etag !== draft.baselineEtag) {
      setDraft(reloadLatestTextDraft(file))
      setAwaitingReload(false)
      return
    }
    setAwaitingReload(true)
    live.checkNow()
  }

  return {
    text: draft?.text ?? (isText && file !== null ? new TextDecoder().decode(file.data) : ''),
    conflict: draft?.conflict === true,
    status: documentSaveStatus({ draft, saving }),
    saving,
    error,
    clearError: () => setError(null),
    edit: text => setDraft(current => (current === null ? current : editTextDraft(current, text))),
    save,
    reloadLatest,
  }
}
