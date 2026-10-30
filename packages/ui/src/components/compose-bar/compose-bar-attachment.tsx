'use client'

import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FilePdf,
  FileText,
  FileVideo,
  X,
  type Icon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import type { ComposeBarAttachment } from './types'

type AttachmentKind = {
  icon: Icon
  tone: string
}

const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  pdf: { icon: FilePdf, tone: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  csv: {
    icon: FileText,
    tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  tsv: {
    icon: FileText,
    tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  md: { icon: FileText, tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  txt: { icon: FileText, tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-400' },
  json: {
    icon: FileCode,
    tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
  },
  zip: {
    icon: FileArchive,
    tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  png: { icon: FileImage, tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  jpg: { icon: FileImage, tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  jpeg: { icon: FileImage, tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  gif: { icon: FileImage, tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  webp: { icon: FileImage, tone: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  mp3: { icon: FileAudio, tone: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400' },
  wav: { icon: FileAudio, tone: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400' },
  mp4: { icon: FileVideo, tone: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  webm: { icon: FileVideo, tone: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
}

function attachmentExtension(name: string) {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined
  return extension || 'file'
}

export function AttachmentCard({
  name,
  meta,
  preview,
  status,
  className,
}: {
  name: string
  meta?: string
  preview?: ReactNode
  status?: ComposeBarAttachment['status']
  className?: string
}) {
  const extension = attachmentExtension(name)
  const kind = EXTENSION_KINDS[extension] ?? {
    icon: FileText,
    tone: 'bg-muted text-muted-foreground',
  }
  const KindIcon = kind.icon

  return (
    <div
      data-attachment-card
      className={cn(
        'relative flex h-32 w-44 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left text-foreground shadow-sm',
        className,
      )}
    >
      <div
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden border-b border-border/60',
          kind.tone,
        )}
      >
        {preview ?? (
          <span className="flex flex-col items-center gap-1.5">
            <KindIcon className="size-7" weight="duotone" aria-hidden />
          </span>
        )}
      </div>
      <div className="min-w-0 shrink-0 bg-card px-2.5 py-2">
        <p className="truncate text-xs font-medium leading-4" title={name}>
          {name}
        </p>
        <p className="mt-0.5 truncate text-[11px] font-medium uppercase leading-4 tracking-wide text-muted-foreground">
          {extension}
          {meta ? ` · ${meta}` : ''}
        </p>
      </div>
      {status?.display === 'badge' ? (
        <span className="absolute left-1.5 top-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1 text-[11px] font-semibold leading-none text-foreground shadow-sm">
          {status.label}
        </span>
      ) : status ? (
        <div
          className={cn(
            'absolute inset-0 grid place-items-center bg-background/85 px-3 text-center text-xs font-semibold backdrop-blur-[2px]',
            status.tone === 'danger'
              ? 'bottom-[3.25rem] place-items-start justify-center pt-4 text-destructive'
              : 'text-foreground',
          )}
        >
          {status.label}
        </div>
      ) : null}
    </div>
  )
}

export function ComposeBarAttachmentCard({
  attachment,
  disabled,
  onRemove,
  onRetry,
  retryLabel,
  removeLabel,
  renderPreview,
}: {
  attachment: ComposeBarAttachment
  disabled: boolean
  onRemove?: (attachment: ComposeBarAttachment) => void
  onRetry?: (attachment: ComposeBarAttachment) => void
  retryLabel: string
  removeLabel: (attachment: ComposeBarAttachment) => string
  renderPreview?: (attachment: ComposeBarAttachment) => ReactNode
}) {
  return (
    <div className="group relative shrink-0">
      <AttachmentCard
        name={attachment.name}
        meta={attachment.meta}
        preview={renderPreview?.(attachment) ?? attachmentPreview(attachment)}
        status={attachment.status}
        className="w-36 sm:w-40"
      />
      {attachment.status?.tone === 'danger' && onRetry ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRetry(attachment)}
          className="absolute left-1/2 top-10 z-10 -translate-x-1/2 rounded-full border border-destructive/40 bg-background px-3 py-1 text-[11px] font-semibold text-destructive shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {retryLabel}
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel(attachment)}
          title={removeLabel(attachment)}
          disabled={disabled}
          onClick={() => onRemove(attachment)}
          className="absolute right-1.5 top-1.5 z-10 flex size-7 items-center justify-center rounded-full border border-border bg-background/95 text-foreground shadow-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="size-4" weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

export function attachmentPreview(attachment: ComposeBarAttachment): ReactNode {
  const preview = attachment.preview
  if (preview?.kind === 'image')
    return (
      <span
        aria-hidden
        className="size-full bg-contain bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${JSON.stringify(preview.src)})` }}
      />
    )
  if (preview?.kind === 'text')
    return (
      <pre
        aria-hidden
        className="size-full overflow-hidden whitespace-pre-wrap break-words bg-sky-950/[0.04] p-2 font-mono text-[10px] leading-3.5 text-foreground/80 dark:bg-sky-50/[0.04]"
      >
        {preview.text}
      </pre>
    )
  if (preview?.kind === 'table')
    return (
      <span className="grid size-full content-center gap-px bg-emerald-950/10 p-2" aria-hidden>
        {preview.rows.map((row, rowIndex) => (
          <span key={rowIndex} className="grid grid-cols-3 gap-px">
            {row.map((cell, cellIndex) => (
              <span
                key={cellIndex}
                className="truncate rounded-[2px] bg-background/90 px-1 py-0.5 text-[10px] leading-3.5 text-foreground/85"
              >
                {cell}
              </span>
            ))}
          </span>
        ))}
      </span>
    )
  return undefined
}
