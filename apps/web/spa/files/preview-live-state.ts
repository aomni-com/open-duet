import type { DirectoryEntry, IFileSystemProvider, VersionedFile } from './lib/types'
import { resolvePreviewPresentation, type PreviewMode } from './preview-presentation'
import type { LiveFileSnapshotLoader, LiveFileState } from './use-live-file'

export type TextDraft = {
  text: string
  baselineText: string
  baselineEtag: string | null
  conflict: boolean
}

const decodeText = (file: VersionedFile): string => new TextDecoder().decode(file.data)

export function createTextDraft(file: VersionedFile): TextDraft {
  const text = decodeText(file)
  return { text, baselineText: text, baselineEtag: file.etag, conflict: false }
}

export function isTextDraftDirty(draft: TextDraft): boolean {
  return draft.text !== draft.baselineText
}

export function editTextDraft(draft: TextDraft, text: string): TextDraft {
  return text === draft.text ? draft : { ...draft, text }
}

/**
 * Fold a freshly read remote snapshot into the draft.
 *
 * A conflict is a disagreement about *content*, so the bytes decide it — never
 * the ETag alone. The drive's ETag carries the inode and ctime, so every
 * atomic rewrite, metadata touch or sync round trip mints a new identity for
 * bytes nobody changed; treating that as a conflict is how an editor comes to
 * accuse its only author of racing themselves.
 */
export function acceptRemoteTextSnapshot(draft: TextDraft, file: VersionedFile): TextDraft {
  if (file.etag === draft.baselineEtag) return draft
  const remoteText = decodeText(file)
  // The remote already says what this draft says: whoever wrote it wrote the
  // same words, so the draft is saved rather than in conflict.
  if (remoteText === draft.text) return createTextDraft(file)
  // Same bytes as the baseline under a new identity — adopt the identity so
  // the next write can match it, and leave the unsaved words alone.
  if (remoteText === draft.baselineText) return { ...draft, baselineEtag: file.etag }
  if (draft.conflict || isTextDraftDirty(draft)) return { ...draft, conflict: true }
  return createTextDraft(file)
}

export function reloadLatestTextDraft(file: VersionedFile): TextDraft {
  return createTextDraft(file)
}

/**
 * Fold a landed write into the draft. The new baseline is the text that was
 * actually written, never whatever the textarea holds now — under autosave the
 * reader keeps typing through the round trip, and claiming those later words
 * were saved is how an editor loses a sentence and reports success.
 */
export function acceptLocalTextSave(
  draft: TextDraft,
  savedText: string,
  etag: string | null,
): TextDraft {
  return {
    text: draft.text,
    baselineText: savedText,
    baselineEtag: etag,
    conflict: false,
  }
}

/**
 * What a rejected write means once the current file has been read back.
 *
 * `settled` — the file already says what the draft says (our own write landed
 * and only its answer was lost). `retry` — the bytes are still the ones this
 * draft was based on, so the rejection was about identity, not content: write
 * again against the identity now on disk. `conflict` — the content genuinely
 * moved under us, which is the only case a reader should ever be asked about.
 */
export type RejectedSaveResolution =
  | { kind: 'settled'; etag: string | null }
  | { kind: 'retry'; ifMatch: string | null }
  | { kind: 'conflict' }

export function resolveRejectedSave(
  draft: TextDraft,
  latest: VersionedFile,
): RejectedSaveResolution {
  const latestText = decodeText(latest)
  if (latestText === draft.text) return { kind: 'settled', etag: latest.etag }
  if (latestText === draft.baselineText) return { kind: 'retry', ifMatch: latest.etag }
  return { kind: 'conflict' }
}

export function markTextSaveConflict(draft: TextDraft): TextDraft {
  return draft.conflict ? draft : { ...draft, conflict: true }
}

/**
 * How long the editor lets the typing settle before it writes. Long enough
 * that a sentence is one write rather than forty, short enough that walking
 * away from the keyboard means the words are already on the drive.
 */
export const AUTOSAVE_DEBOUNCE_MS = 800

export function autosaveWanted(input: {
  draft: TextDraft | null
  saving: boolean
  mutationsUnavailable: boolean
  /**
   * Text the drive already refused for a reason that will not resolve on its
   * own. Autosave is scheduled off the draft, so retrying it would fire the
   * same rejected write every debounce forever; the next keystroke is what
   * asks again.
   */
  refusedText?: string | null
}): boolean {
  const { draft } = input
  if (draft === null || draft.conflict) return false
  if (draft.text === input.refusedText) return false
  return isTextDraftDirty(draft) && !input.saving && !input.mutationsUnavailable
}

export type DocumentSaveStatus = 'none' | 'conflict' | 'saving' | 'unsaved' | 'saved'

export function documentSaveStatus(input: {
  draft: TextDraft | null
  saving: boolean
}): DocumentSaveStatus {
  const { draft } = input
  if (draft === null) return 'none'
  if (draft.conflict) return 'conflict'
  if (input.saving) return 'saving'
  return isTextDraftDirty(draft) ? 'unsaved' : 'saved'
}

export function supportsLivePreviewRefresh(entry: Pick<DirectoryEntry, 'type'>): boolean {
  return entry.type !== 'symlink'
}

export function liveMutationsUnavailable(phase: LiveFileState['phase']): boolean {
  return phase === 'reconnecting' || phase === 'missing'
}

export function isPreconditionFailedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 412 &&
    'code' in error &&
    error.code === 'precondition_failed'
  )
}

export function previewSourceDescriptor(
  provider: Pick<IFileSystemProvider, 'downloadUrl'>,
  path: string,
  etag: string | null,
  live: boolean,
): { url: string; key?: string } {
  return live && etag !== null
    ? { url: provider.downloadUrl(path, { version: etag }), key: `${path}:${etag}` }
    : { url: provider.downloadUrl(path) }
}

export function createPreviewSnapshotLoader(
  provider: Pick<IFileSystemProvider, 'readVersioned' | 'readRange'>,
  mode: PreviewMode,
): LiveFileSnapshotLoader {
  return (entry, signal) => {
    const presentation = resolvePreviewPresentation(entry.name, entry.size, mode)
    return presentation.loadStrategy === 'versioned'
      ? provider.readVersioned(entry.path, { signal })
      : provider.readRange(entry.path, { start: 0, end: 4095 }, { signal })
  }
}
