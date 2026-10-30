import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import {
  AGENT_INPUT_ATTACHMENT_MAX_COUNT,
  AGENT_INPUT_IMAGE_MAX_BYTES,
  AGENT_INPUT_IMAGE_MAX_COUNT,
  AGENT_INPUT_IMAGE_MIME_TYPES,
  attachmentFileName,
  attachmentLandingPrefix,
  canonicalAgentCwd,
  exceedsDriveUploadLimit,
  FILE_TOO_LARGE_ERROR,
  isTextLikeDriveFile,
  type AgentEventAttachment,
  type AgentInputImage,
} from '@repo/contract'
import type { ComposeBarAttachment } from '@repo/ui/components/compose-bar'

import { SessionAttachmentUploads } from '../api/session-attachment-uploads'
import { uploadErrorCode, type UploadRequest } from '../api/vm-uploads'
import { useSpa } from '../context'
import { encodeSessionImage } from './session-images'

export type SessionAttachmentUploader = Pick<
  SessionAttachmentUploads,
  'put' | 'delete' | 'exists' | 'mkdir' | 'move'
>

type AttachmentPhase = 'encoding' | 'uploading' | 'moving' | 'ready' | 'failed'

/**
 * Why an attachment failed, in words.
 *
 * Declared exactly twice — this key set and the fallback literal below — and
 * both are compiler-checked, so a new reason cannot be added to one and
 * forgotten in the other. It used to be written down four times, and the
 * lookup fell back to "Upload failed" for whichever copy was missed.
 */
export type SessionAttachmentErrorLabels = Record<
  | 'default'
  | 'workspace_paused'
  | 'workspace_provisioning'
  | 'workspace_archived'
  | 'storage_full'
  | 'file_too_large',
  string
>

export const DEFAULT_ATTACHMENT_ERROR_LABELS: SessionAttachmentErrorLabels = {
  default: 'Upload failed',
  workspace_paused: 'Workspace paused',
  workspace_provisioning: 'Workspace provisioning',
  workspace_archived: 'Workspace archived',
  storage_full: 'Storage full',
  file_too_large: 'File too large',
}

export type SessionAttachmentLabels = {
  uploading: (percent: number) => string
  ready: string
  moving: string
  preparing: string
}

type DraftAttachment = {
  id: string
  kind: 'image' | 'file'
  file: File
  name: string
  phase: AttachmentPhase
  removed: boolean
  image?: AgentInputImage
  cwd?: string
  filename?: string
  path?: string
  landed: boolean
  progress: number
  upload?: UploadRequest
  collision: number
  errorCode?: string
  preview?: ComposeBarAttachment['preview']
  objectUrl?: string
}

export type SessionAttachmentSnapshot = {
  items: readonly ComposeBarAttachment[]
  busy: boolean
  key: string
}

export type SessionAttachmentPayload = {
  images: AgentInputImage[]
  attachments: AgentEventAttachment[]
}

export type SessionAttachmentDraft = SessionAttachmentSnapshot & {
  add(files: readonly File[]): boolean
  remove(attachment: ComposeBarAttachment): void
  retry(id: string): void
  payload(): SessionAttachmentPayload
  drafting(): boolean
  /** Takes the draft's files out for a send and returns what that send carries. */
  beginSubmission(): SessionAttachmentPayload
  restoreSubmission(): void
  rejectSubmission(): void
  commit(): void
  discard(): void
}

export function createSessionAttachmentDraft(options: {
  scopeCwd: string | undefined
  uploader: SessionAttachmentUploader
  id?: () => string
  onError?: (error: unknown) => void
  errorLabels?: () => SessionAttachmentErrorLabels
  labels?: SessionAttachmentLabels
  onTooMany?: () => void
}) {
  return new SessionAttachmentDraftOwner(options)
}

class SessionAttachmentDraftOwner {
  private readonly uploader: SessionAttachmentUploader
  private readonly id: () => string
  private readonly onError: (error: unknown) => void
  private readonly errorLabels: () => SessionAttachmentErrorLabels
  private readonly labels: SessionAttachmentLabels
  private readonly onTooMany: () => void
  private records: DraftAttachment[] = []
  /* The batch a send in flight carries. It leaves the draft when the send
     starts, so the composer stays a place to gather the next message: files
     picked meanwhile land in `records`, a commit forgets only this batch, and
     a failed send puts it back in front of them. */
  private submitted: DraftAttachment[] = []
  private scopeCwd: string | undefined
  private listeners = new Set<() => void>()
  private current: SessionAttachmentSnapshot = { items: [], busy: false, key: '' }
  private rehome = Promise.resolve()
  private naming = Promise.resolve()
  private submissionPaths: Set<string>[] = []

  constructor(options: {
    scopeCwd: string | undefined
    uploader: SessionAttachmentUploader
    id?: () => string
    onError?: (error: unknown) => void
    errorLabels?: () => SessionAttachmentErrorLabels
    labels?: SessionAttachmentLabels
    onTooMany?: () => void
  }) {
    this.scopeCwd = canonicalScopeCwd(options.scopeCwd)
    this.uploader = options.uploader
    this.id = options.id ?? (() => crypto.randomUUID())
    this.onError = options.onError ?? (() => {})
    this.errorLabels = options.errorLabels ?? (() => DEFAULT_ATTACHMENT_ERROR_LABELS)
    this.labels = options.labels ?? {
      uploading: percent => `Uploading · ${percent}%`,
      ready: 'Ready',
      moving: 'Moving',
      preparing: 'Preparing',
    }
    this.onTooMany = options.onTooMany ?? (() => {})
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly snapshot = () => this.current

  /** Whether the draft holds files of its own, read live rather than from a render. */
  readonly drafting = () => this.records.length > 0

  readonly add = (files: readonly File[]) => {
    // Caps count the in-flight batch too, so a failed send can always rejoin
    // the draft without overflowing what one message may carry.
    const held = [...this.submitted, ...this.records]
    if (files.length > AGENT_INPUT_ATTACHMENT_MAX_COUNT - held.length) this.onTooMany()
    if (held.length >= AGENT_INPUT_ATTACHMENT_MAX_COUNT) return false
    let imageCount = held.filter(record => record.kind === 'image').length
    for (const file of files.slice(0, AGENT_INPUT_ATTACHMENT_MAX_COUNT - held.length)) {
      const inline = isInlineImage(file) && imageCount < AGENT_INPUT_IMAGE_MAX_COUNT
      const record: DraftAttachment = {
        id: this.id(),
        kind: inline ? 'image' : 'file',
        file,
        name: attachmentFileName(file.name),
        phase: inline ? 'encoding' : 'uploading',
        removed: false,
        cwd: this.scopeCwd,
        landed: false,
        progress: 0,
        collision: 1,
      }
      if (
        inline ||
        (file.size <= AGENT_INPUT_IMAGE_MAX_BYTES &&
          AGENT_INPUT_IMAGE_MIME_TYPES.some(mimeType => mimeType === file.type))
      ) {
        record.objectUrl = URL.createObjectURL(file)
        record.preview = { kind: 'image', src: record.objectUrl }
      } else if (isTextPreview(file)) void this.readPreview(record)
      if (inline) imageCount += 1
      this.records.push(record)
      if (inline) void this.encode(record)
      else void this.upload(record)
    }
    this.publish()
    return true
  }

  readonly remove = (attachment: ComposeBarAttachment) => {
    const record = this.records.find(candidate => candidate.id === attachment.id)
    if (record === undefined) return
    record.removed = true
    if (record.objectUrl !== undefined) URL.revokeObjectURL(record.objectUrl)
    record.upload?.abort()
    this.records = this.records.filter(candidate => candidate !== record)
    this.publish()
    if (
      record.landed &&
      record.filename !== undefined &&
      record.phase !== 'moving' &&
      !this.isSubmissionPath(record.path)
    ) {
      void this.uploader.delete(record.cwd, record.filename).catch(() => undefined)
    }
  }

  readonly retry = (id: string) => {
    const record = this.records.find(candidate => candidate.id === id)
    if (record?.phase !== 'failed') return
    if (record.kind === 'image') void this.encode(record)
    else if (record.landed) this.queueRehome()
    else void this.upload(record)
  }

  readonly payload = (): SessionAttachmentPayload => {
    if (this.current.busy) throw new Error('Attachments are not ready')
    return {
      images: this.records.flatMap(record =>
        record.kind === 'image' && record.image !== undefined ? [record.image] : [],
      ),
      attachments: this.records.flatMap(record =>
        record.kind === 'file' && record.path !== undefined
          ? [
              {
                path: record.path,
                name: record.name,
                bytes: record.file.size,
                ...(record.file.type === '' ? {} : { mimeType: record.file.type }),
              },
            ]
          : [],
      ),
    }
  }

  readonly commit = () => {
    this.submissionPaths = []
    this.release(this.submitted, false)
    this.submitted = []
    this.publish()
  }

  readonly discard = () => {
    this.release([...this.submitted, ...this.records], true)
    this.submitted = []
    this.records = []
    this.publish()
    this.submissionPaths = []
  }

  readonly beginSubmission = (): SessionAttachmentPayload => {
    const payload = this.payload()
    this.submissionPaths.push(
      new Set(
        this.records.flatMap(record =>
          record.kind === 'file' && record.path !== undefined ? [record.path] : [],
        ),
      ),
    )
    this.submitted = [...this.submitted, ...this.records]
    this.records = []
    this.publish()
    return payload
  }

  readonly restoreSubmission = () => {
    this.records = [...this.submitted, ...this.records]
    this.submitted = []
    this.publish()
  }

  readonly rejectSubmission = () => {
    this.submissionPaths.pop()
    this.restoreSubmission()
  }

  private release(records: readonly DraftAttachment[], deleteLanded: boolean) {
    for (const record of records) {
      record.removed = true
      if (!deleteLanded || record.kind === 'image' || record.phase !== 'uploading') {
        record.upload?.abort()
      }
      if (record.objectUrl !== undefined) URL.revokeObjectURL(record.objectUrl)
      if (
        deleteLanded &&
        record.landed &&
        record.filename !== undefined &&
        !this.isSubmissionPath(record.path)
      ) {
        void this.uploader.delete(record.cwd, record.filename).catch(() => undefined)
      }
    }
  }

  setScopeCwd(scopeCwd: string | undefined) {
    const canonicalCwd = canonicalScopeCwd(scopeCwd)
    if (canonicalCwd === this.scopeCwd) return
    this.scopeCwd = canonicalCwd
    this.queueRehome()
  }

  private async encode(record: DraftAttachment) {
    record.phase = 'encoding'
    this.publish()
    try {
      record.image = await encodeSessionImage(record.file)
      if (!record.removed) record.phase = 'ready'
    } catch {
      if (!record.removed) record.phase = 'failed'
    }
    this.publish()
  }

  private async readPreview(record: DraftAttachment) {
    try {
      const text = await record.file.slice(0, 4096).text()
      if (record.removed) return
      const extension = record.name.split('.').at(-1)?.toLowerCase()
      record.preview =
        extension === 'csv' || extension === 'tsv'
          ? {
              kind: 'table',
              rows: text
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(0, 4)
                .map(row => row.split(extension === 'tsv' ? '\t' : ',').slice(0, 3)),
            }
          : { kind: 'text', text }
      this.publish()
    } catch {
      // Preview is a convenience; the attachment remains valid without one.
    }
  }

  private async upload(record: DraftAttachment) {
    /* Here rather than in `add`, because `retry` re-enters this method
       directly: a check at pick time would leave the Retry button on a refused
       chip free to start a transfer that cannot succeed. Returning before
       `claimFilename` also means no request at all — that is a network `stat`,
       and a file this size is refusable without asking the workspace anything. */
    if (exceedsDriveUploadLimit(record.file.size)) {
      record.phase = 'failed'
      record.errorCode = FILE_TOO_LARGE_ERROR
      this.publish()
      return
    }
    record.phase = 'uploading'
    record.progress = 0
    record.errorCode = undefined
    record.cwd = this.scopeCwd
    this.publish()
    try {
      const available = await this.claimFilename(record)
      if (record.removed) return
      record.filename = available.filename
      record.collision = available.collision
      const request = this.uploader.put(record.cwd, available.filename, record.file, progress => {
        if (record.removed) return
        record.progress = progress
        this.publish()
      })
      record.upload = request
      await request.done
      record.upload = undefined
      record.landed = true
      record.path = landedPath(record.cwd, available.filename)
      if (record.removed) {
        await this.uploader.delete(record.cwd, available.filename).catch(() => undefined)
        return
      }
      record.phase = 'ready'
      this.publish()
      if (record.cwd !== this.scopeCwd) this.queueRehome()
    } catch (error) {
      record.upload = undefined
      if (record.removed && record.kind === 'file' && record.filename !== undefined) {
        await this.uploader.delete(record.cwd, record.filename).catch(() => undefined)
      }
      if (!record.removed && !isAbort(error)) {
        record.phase = 'failed'
        record.errorCode = uploadErrorCode(error)
        this.onError(error)
        this.publish()
      }
    }
  }

  private queueRehome() {
    let changed = false
    for (const record of this.records) {
      if (
        record.kind === 'file' &&
        record.landed &&
        record.cwd !== this.scopeCwd &&
        record.phase !== 'uploading' &&
        !this.isSubmissionPath(record.path)
      ) {
        record.phase = 'moving'
        changed = true
      }
    }
    if (changed) this.publish()
    this.rehome = this.rehome.then(() => this.rehomeReady()).catch(() => undefined)
  }

  private async rehomeReady() {
    while (true) {
      const record = this.records.find(
        candidate =>
          candidate.kind === 'file' &&
          candidate.landed &&
          candidate.cwd !== this.scopeCwd &&
          !this.isSubmissionPath(candidate.path) &&
          (candidate.phase === 'ready' || candidate.phase === 'moving'),
      )
      if (record === undefined) return
      record.phase = 'moving'
      this.publish()
      const destinationCwd = this.scopeCwd
      try {
        await this.uploader.mkdir(attachmentLandingPrefix({ cwd: destinationCwd }))
        const available = await this.claimFilename(record, destinationCwd, 1)
        if (record.removed || record.path === undefined) continue
        const destination = landedPath(destinationCwd, available.filename)
        await this.uploader.move(record.path, destination)
        record.cwd = destinationCwd
        record.filename = available.filename
        record.collision = available.collision
        record.path = destination
        if (record.removed) {
          await this.uploader.delete(destinationCwd, available.filename).catch(() => undefined)
          continue
        }
        record.phase = 'ready'
      } catch (error) {
        if (record.removed && record.filename !== undefined) {
          await this.uploader.delete(record.cwd, record.filename).catch(() => undefined)
        } else {
          record.phase = 'failed'
          record.errorCode = uploadErrorCode(error)
          this.onError(error)
        }
        this.publish()
        return
      }
      this.publish()
    }
  }

  private async availableFilename(
    record: DraftAttachment,
    cwd = record.cwd,
    startingCollision = record.collision,
  ) {
    let collision = startingCollision
    while (true) {
      const filename = collisionFilename(record.name, collision)
      const locallyUsed = this.records.some(
        candidate =>
          candidate !== record &&
          !candidate.removed &&
          candidate.kind === 'file' &&
          candidate.cwd === cwd &&
          candidate.filename === filename,
      )
      if (!locallyUsed && !(await this.uploader.exists(cwd, filename))) {
        return { filename, collision }
      }
      collision += 1
    }
  }

  private claimFilename(
    record: DraftAttachment,
    cwd = record.cwd,
    startingCollision = record.collision,
  ) {
    const claimed = this.naming.then(() => this.availableFilename(record, cwd, startingCollision))
    this.naming = claimed.then(
      () => undefined,
      () => undefined,
    )
    return claimed
  }

  private isSubmissionPath(path: string | undefined): boolean {
    return path !== undefined && this.submissionPaths.some(paths => paths.has(path))
  }

  private publish() {
    this.current = {
      items: this.records.map(record =>
        toComposeAttachment(record, this.labels, this.errorLabels()),
      ),
      busy: this.records.some(record => record.phase !== 'ready'),
      key: this.records
        .map(record => {
          const location = record.kind === 'file' ? (record.path ?? record.cwd) : undefined
          return location === undefined ? record.id : `${record.id}:${location}`
        })
        .join(':'),
    }
    for (const listener of this.listeners) listener()
  }
}

export function useSessionAttachments(options: {
  workspaceSlug: string
  scopeCwd: string | undefined
  uploader?: SessionAttachmentUploader
  onError?: (error: unknown) => void
  /* A snapshot here, because a render is where translated labels come from;
     the ref below is what turns it into the resolver the draft reads, so the
     draft is never holding one render's words. */
  errorLabels?: SessionAttachmentErrorLabels
  labels?: SessionAttachmentLabels
  onTooMany?: () => void
}): SessionAttachmentDraft {
  const { identity } = useSpa()
  const presentation = useRef(options)
  presentation.current = options
  const draft = useMemo(() => {
    return createSessionAttachmentDraft({
      scopeCwd: undefined,
      uploader:
        options.uploader ??
        new SessionAttachmentUploads({
          workspaceSlug: options.workspaceSlug,
        }),
      onError: error => presentation.current.onError?.(error),
      /* A resolver rather than a snapshot, so the draft reads whatever the
         current render supplied. The object of getters this replaces was a
         third place the key set was written down, and every new reason had to
         remember it or fall silently back to "Upload failed". */
      errorLabels: () => presentation.current.errorLabels ?? DEFAULT_ATTACHMENT_ERROR_LABELS,
      labels: {
        uploading: percent =>
          presentation.current.labels?.uploading(percent) ?? `Uploading · ${percent}%`,
        get ready() {
          return presentation.current.labels?.ready ?? 'Ready'
        },
        get moving() {
          return presentation.current.labels?.moving ?? 'Moving'
        },
        get preparing() {
          return presentation.current.labels?.preparing ?? 'Preparing'
        },
      },
      onTooMany: () => presentation.current.onTooMany?.(),
    })
    // A different signed-in user starts a new draft even when the workspace stays the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.user.id, options.uploader, options.workspaceSlug])
  useEffect(() => draft.setScopeCwd(options.scopeCwd), [draft, options.scopeCwd])
  useEffect(() => () => draft.discard(), [draft])
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot)
  return {
    ...state,
    add: draft.add,
    remove: draft.remove,
    retry: draft.retry,
    payload: draft.payload,
    drafting: draft.drafting,
    beginSubmission: draft.beginSubmission,
    restoreSubmission: draft.restoreSubmission,
    rejectSubmission: draft.rejectSubmission,
    commit: draft.commit,
    discard: draft.discard,
  }
}

function isInlineImage(file: File): boolean {
  return (
    file.size <= AGENT_INPUT_IMAGE_MAX_BYTES &&
    AGENT_INPUT_IMAGE_MIME_TYPES.some(mimeType => mimeType === file.type)
  )
}

function landedPath(cwd: string | undefined, filename: string): string {
  return `${attachmentLandingPrefix({ cwd })}/${filename}`
}

function canonicalScopeCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  return canonicalAgentCwd(cwd)
}

function collisionFilename(name: string, collision: number): string {
  if (collision === 1) return name
  const extensionAt = name.lastIndexOf('.')
  const extension = extensionAt > 0 ? name.slice(extensionAt) : ''
  const stem = extensionAt > 0 ? name.slice(0, extensionAt) : name
  const suffix = ` (${collision})`
  const maxStemBytes = 255 - bytes(extension) - bytes(suffix)
  return `${truncate(stem, maxStemBytes)}${suffix}${extension}`
}

function truncate(value: string, maxBytes: number): string {
  let result = ''
  for (const character of value) {
    if (bytes(result) + bytes(character) > maxBytes) break
    result += character
  }
  return result
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function toComposeAttachment(
  record: DraftAttachment,
  labels: SessionAttachmentLabels,
  errorLabels: SessionAttachmentErrorLabels,
): ComposeBarAttachment {
  return {
    id: record.id,
    name: record.name,
    meta: record.file.type || undefined,
    ...(record.preview === undefined ? {} : { preview: record.preview }),
    ...(record.kind === 'image' && record.phase === 'ready'
      ? {}
      : record.phase === 'failed'
        ? {
            status: {
              label:
                errorLabels[record.errorCode as keyof SessionAttachmentErrorLabels] ??
                errorLabels.default,
              tone: 'danger' as const,
            },
          }
        : record.phase === 'ready'
          ? { status: { label: labels.ready, display: 'badge' as const } }
          : record.phase === 'moving'
            ? { status: { label: labels.moving } }
            : record.kind === 'file'
              ? { status: { label: labels.uploading(record.progress) } }
              : { status: { label: labels.preparing } }),
  }
}

function isTextPreview(file: File): boolean {
  return file.type.startsWith('text/') || isTextLikeDriveFile(file.name)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
