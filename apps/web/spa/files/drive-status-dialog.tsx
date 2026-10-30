'use client'

import { FolderIcon, HardDriveIcon, StackIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import { cn } from '@repo/ui/lib/utils'

import { formatBytes } from '../format'
import { fileKind, type FileKindKey } from './file-glyph'
import type { DirectoryEntry } from './lib/types'

const formatBytesDecimal = (bytes: number) => formatBytes(bytes, 1000)

export type DriveUsageSlice = {
  kind: FileKindKey
  bytes: number
  count: number
}

export type DriveUsage = {
  folders: number
  documents: number
  totalBytes: number
  slices: DriveUsageSlice[]
}

/**
 * Roll the open folder's entries into a drive-status summary: folder and
 * document counts, the real byte total, and per-kind slices (bytes + count)
 * ordered largest-first, carrying only the kinds actually present. Pure, so
 * the status panel and its test read the same numbers the footer shows.
 */
export function summarizeDriveUsage(entries: readonly DirectoryEntry[]): DriveUsage {
  let folders = 0
  let documents = 0
  let totalBytes = 0
  const byKind = new Map<FileKindKey, { bytes: number; count: number }>()
  for (const entry of entries) {
    if (entry.isDirectory) {
      folders += 1
      continue
    }
    documents += 1
    const bytes = entry.size ?? 0
    totalBytes += bytes
    const key = fileKind(entry.name).key
    const slot = byKind.get(key) ?? { bytes: 0, count: 0 }
    slot.bytes += bytes
    slot.count += 1
    byKind.set(key, slot)
  }
  const slices = [...byKind.entries()]
    .map(([kind, slot]) => ({ kind, bytes: slot.bytes, count: slot.count }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.kind.localeCompare(b.kind))
  return { folders, documents, totalBytes, slices }
}

/**
 * The drive-status panel reached from the footer's size readout: a calm hero
 * with the total, a segmented usage bar colored by file kind (same hues as
 * the glyphs), a legend with per-kind counts and sizes, and the folder /
 * document tallies for the open location.
 */
export function DriveStatusDialog({
  open,
  onOpenChange,
  path,
  entries,
  incomplete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  path: string
  entries: readonly DirectoryEntry[]
  /** The directory endpoint has another page, so every metric is a loaded prefix. */
  incomplete: boolean
}) {
  const t = useTranslations('duetApp.filesSurface.status')
  const usage = summarizeDriveUsage(entries)
  const hasData = usage.totalBytes > 0
  const location = path === '/' ? t('rootLocation') : path

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand/[0.08] text-brand ring-1 ring-inset ring-brand/10"
          >
            <HardDriveIcon weight="duotone" className="size-6" />
          </span>
          <div className="min-w-0">
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription className="truncate">
              {t('locationLabel', { location })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
          <p className="text-3xl font-semibold tabular-nums tracking-tight">
            {incomplete
              ? t('loadedBytes', { bytes: formatBytesDecimal(usage.totalBytes) })
              : formatBytesDecimal(usage.totalBytes)}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(incomplete ? 'acrossLoadedItems' : 'acrossItems', {
              documents: usage.documents,
              folders: usage.folders,
            })}
          </p>
          <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {hasData ? (
              usage.slices.map(slice => (
                <span
                  key={slice.kind}
                  className={cn('h-full', fileKind(sampleName(slice.kind)).bar)}
                  style={{ width: `${(slice.bytes / usage.totalBytes) * 100}%` }}
                  title={kindLabel(t, slice.kind)}
                />
              ))
            ) : (
              <span className="h-full w-full bg-muted" />
            )}
          </div>
        </div>

        {hasData ? (
          <ul className="flex flex-col gap-2">
            {usage.slices.map(slice => (
              <li key={slice.kind} className="flex items-center gap-2.5 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    'size-2.5 shrink-0 rounded-full',
                    fileKind(sampleName(slice.kind)).bar,
                  )}
                />
                <span className="flex-1 truncate font-medium">{kindLabel(t, slice.kind)}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('sliceCount', { count: slice.count })}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                  {formatBytesDecimal(slice.bytes)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-center text-sm text-muted-foreground">
            {t(incomplete ? 'emptyLoadedBody' : 'emptyBody')}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 border-t border-border/60 pt-4">
          <StatTile
            icon={<FolderIcon weight="duotone" />}
            label={t(incomplete ? 'loadedFolders' : 'folders')}
            value={usage.folders}
          />
          <StatTile
            icon={<StackIcon weight="duotone" />}
            label={t(incomplete ? 'loadedDocuments' : 'documents')}
            value={usage.documents}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-card p-3">
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold tabular-nums leading-none">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

// The usage bar and legend color by kind through the FileGlyph table; a
// representative filename per kind resolves to the right FileKind without
// duplicating the extension map here.
const KIND_SAMPLE: Record<FileKindKey, string> = {
  pdf: 'a.pdf',
  slides: 'a.pptx',
  sheets: 'a.xlsx',
  image: 'a.png',
  audio: 'a.mp3',
  video: 'a.mp4',
  archive: 'a.zip',
  code: 'a.ts',
  text: 'a.md',
  other: 'a.bin',
}

function sampleName(kind: FileKindKey): string {
  return KIND_SAMPLE[kind]
}

function kindLabel(t: (key: string) => string, kind: FileKindKey): string {
  return t(`kind.${kind}`)
}
