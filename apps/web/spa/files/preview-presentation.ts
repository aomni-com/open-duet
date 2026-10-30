import { isTextLikeDriveFile } from '@repo/contract'

/**
 * How a document is presented, orthogonal along three axes so the one
 * `PreviewPane` renders both the authenticated-editable Drive and the anonymous
 * read-only Publish viewer:
 * - `access` — whether text can be edited/saved at all.
 * - `textPresentation` — `rich` renders Markdown and treats SVG as an image
 *   (today's Drive); `source` shows every text-like file — Markdown and SVG
 *   included — as its raw source, closing the script-in-SVG hole for publish.
 * - `attribution` — whether the seen-by strip and history drawer appear.
 */
export type PreviewMode = {
  access: 'editable' | 'read-only'
  textPresentation: 'rich' | 'source'
  attribution: 'show' | 'hide'
}

export const EDITABLE_PREVIEW_MODE: PreviewMode = {
  access: 'editable',
  textPresentation: 'rich',
  attribution: 'show',
}

export const READONLY_SOURCE_PREVIEW_MODE: PreviewMode = {
  access: 'read-only',
  textPresentation: 'source',
  attribution: 'hide',
}

/** Authenticated inspection outside Drive: rich rendering, without editing or attribution chrome. */
export const READONLY_RICH_PREVIEW_MODE: PreviewMode = {
  access: 'read-only',
  textPresentation: 'rich',
  attribution: 'hide',
}

// Office documents render through the office viewer; the ceiling below is the
// largest workbook/deck we decode inline before offering a download instead.
const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'key',
  'numbers',
  'odp',
  'ods',
  'odt',
  'pages',
  'ppt',
  'pptx',
  'rtf',
  'xls',
  'xlsb',
  'xlsm',
  'xlsx',
])
export const MAX_OFFICE_PREVIEW_BYTES = 25 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg'])

export type PreviewBinaryViewer = 'office' | 'image' | 'pdf' | 'video' | 'audio' | 'hex'

export type PreviewPresentation = {
  /** The file renders as editable/selectable text (textarea or Markdown). */
  isText: boolean
  /** Markdown handling: a rendered/source toggle, forced source, or n/a. */
  markdown: 'toggle' | 'source' | 'none'
  /** Text may be edited and saved (never in read-only access). */
  editable: boolean
  /** The editor writes as the reader types (editable text only). */
  autosaves: boolean
  /** The file-history drawer is offered (attribution shown only). */
  showHistory: boolean
  /** The seen-by strip is offered (attribution shown only). */
  showSeenBy: boolean
  /** Which binary viewer renders when the file is not text (else `null`). */
  binary: PreviewBinaryViewer | null
  /** Why an office file cannot be decoded inline, or `none` when it can. */
  officeFallback: 'none' | 'unknown-size' | 'too-large'
  /** Whether to read the whole versioned file or just a sniff range. */
  loadStrategy: 'versioned' | 'range'
}

function extensionOf(name: string): string {
  return name.split('.').at(-1)?.toLowerCase() ?? ''
}

export function resolvePreviewPresentation(
  name: string,
  size: number | undefined,
  mode: PreviewMode,
): PreviewPresentation {
  const extension = extensionOf(name)
  const source = mode.textPresentation === 'source'
  const isSvg = extension === 'svg'
  // SVG is text-like in the shared classifier so publish serves it as source,
  // but the authenticated rich viewer keeps rendering it as an image. So SVG
  // counts as text only in source mode; every other text-like file is text in
  // both modes.
  const isText = isTextLikeDriveFile(name) && !(isSvg && !source)
  const isMarkdown = extension === 'md' || extension === 'mdx'
  const office = OFFICE_EXTENSIONS.has(extension)
  // An absent size is not evidence that decoding the whole document is cheap.
  // Callers with a stat-capable provider resolve it before opening; every
  // other surface fails closed to the bounded fallback instead of guessing.
  const officeFallback = !office
    ? 'none'
    : size === undefined
      ? 'unknown-size'
      : size > MAX_OFFICE_PREVIEW_BYTES
        ? 'too-large'
        : 'none'
  const editable = mode.access === 'editable'
  const attribution = mode.attribution === 'show'

  return {
    isText,
    markdown: isText && isMarkdown ? (source ? 'source' : 'toggle') : 'none',
    editable,
    autosaves: isText && editable,
    showHistory: attribution,
    showSeenBy: attribution,
    binary: isText ? null : binaryViewer(extension, office),
    officeFallback,
    loadStrategy: isText || (office && officeFallback === 'none') ? 'versioned' : 'range',
  }
}

function binaryViewer(extension: string, office: boolean): PreviewBinaryViewer {
  if (office) return 'office'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return 'hex'
}
