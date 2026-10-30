'use client'

import { DownloadSimpleIcon, FileDocIcon, FilePptIcon, FileXlsIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { lazy } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'

type OfficeKind = 'spreadsheet' | 'word' | 'presentation' | 'fallback'

const SpreadsheetPreview = lazy(() =>
  import('./spreadsheet-preview').then(module => ({ default: module.SpreadsheetPreview })),
)
const WordPreview = lazy(() =>
  import('./word-preview').then(module => ({ default: module.WordPreview })),
)
const PresentationPreview = lazy(() =>
  import('./presentation-preview').then(module => ({ default: module.PresentationPreview })),
)

export function OfficePreview({
  bytes,
  fileName,
  downloadUrl,
  fallback = 'none',
}: {
  bytes: Uint8Array
  fileName: string
  downloadUrl: string
  fallback?: 'none' | 'unknown-size' | 'too-large'
}) {
  const kind = officeKind(fileName)
  if (fallback !== 'none' || kind === 'fallback') {
    return (
      <OfficeFallback
        fileName={fileName}
        downloadUrl={downloadUrl}
        tooLarge={fallback === 'too-large'}
      />
    )
  }
  if (kind === 'spreadsheet') {
    return <SpreadsheetPreview bytes={bytes} fileName={fileName} downloadUrl={downloadUrl} />
  }
  if (kind === 'word') {
    return <WordPreview bytes={bytes} fileName={fileName} downloadUrl={downloadUrl} />
  }
  return <PresentationPreview bytes={bytes} fileName={fileName} downloadUrl={downloadUrl} />
}

export function officeKind(fileName: string): OfficeKind {
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? ''
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(extension)) return 'spreadsheet'
  if (extension === 'docx') return 'word'
  if (extension === 'pptx') return 'presentation'
  return 'fallback'
}

const FALLBACK_TINTS = {
  spreadsheet: {
    icon: FileXlsIcon,
    tile: 'bg-emerald-500/10 ring-emerald-500/20',
    text: 'text-emerald-500',
  },
  word: { icon: FileDocIcon, tile: 'bg-sky-500/10 ring-sky-500/20', text: 'text-sky-500' },
  presentation: {
    icon: FilePptIcon,
    tile: 'bg-orange-500/10 ring-orange-500/20',
    text: 'text-orange-500',
  },
  fallback: {
    icon: FileDocIcon,
    tile: 'bg-indigo-500/10 ring-indigo-500/20',
    text: 'text-indigo-500',
  },
} as const

export function OfficeFallback({
  fileName,
  downloadUrl,
  tooLarge = false,
}: {
  fileName: string
  downloadUrl?: string
  tooLarge?: boolean
}) {
  const t = useTranslations('duetApp.filesSurface')
  const tint = FALLBACK_TINTS[officeKind(fileName)]
  const Icon = tint.icon
  return (
    <div className="grid h-full min-h-[24rem] place-items-center p-6 sm:p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div
          className={`mb-5 grid size-20 place-items-center rounded-xl ring-1 ring-inset ${tint.tile}`}
        >
          <Icon weight="duotone" className={`size-10 ${tint.text}`} />
        </div>
        <p className="text-base font-semibold">
          {tooLarge ? t('officeTooLarge') : t('officeUnavailable')}
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {t('officeFallback', { name: fileName })}
        </p>
        <span className="mt-4 max-w-full truncate rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {fileName}
        </span>
        {downloadUrl ? (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <a href={downloadUrl} download={fileName}>
              <DownloadSimpleIcon className="mr-2 size-4" />
              {t('download')}
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
