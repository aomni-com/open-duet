import {
  AppWindowIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FolderIcon,
  type Icon,
} from '@phosphor-icons/react'

import { statusClasses, type AppDisplayStatus } from '../status/entity-status'
import type { DirectoryEntry } from './lib/types'

export type FileKindKey =
  | 'pdf'
  | 'slides'
  | 'sheets'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'code'
  | 'text'
  | 'other'

export type FileKind = {
  key: FileKindKey
  icon: Icon
  /** Glyph tint. */
  text: string
  /** Usage-bar segment fill — same hue as the glyph tint. */
  bar: string
}

// One owner for the file-type → presentation mapping: the glyph set, the
// drive-status usage bar, and anything else that colors by kind read from
// this table so hues never drift per surface.
const FILE_KINDS: Array<FileKind & { extensions: string[] }> = [
  { key: 'pdf', extensions: ['pdf'], icon: FilePdfIcon, text: 'text-rose-500', bar: 'bg-rose-500' },
  {
    key: 'slides',
    extensions: ['ppt', 'pptx'],
    icon: FilePptIcon,
    text: 'text-orange-500',
    bar: 'bg-orange-500',
  },
  {
    key: 'sheets',
    extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods'],
    icon: FileXlsIcon,
    text: 'text-green-600',
    bar: 'bg-green-600',
  },
  {
    key: 'image',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
    icon: FileImageIcon,
    text: 'text-violet-500',
    bar: 'bg-violet-500',
  },
  {
    key: 'audio',
    extensions: ['mp3', 'wav', 'm4a', 'ogg'],
    icon: FileAudioIcon,
    text: 'text-cyan-500',
    bar: 'bg-cyan-500',
  },
  {
    key: 'video',
    extensions: ['mp4', 'webm', 'mov'],
    icon: FileVideoIcon,
    text: 'text-blue-500',
    bar: 'bg-blue-500',
  },
  {
    key: 'archive',
    extensions: ['zip', 'tar', 'gz'],
    icon: FileArchiveIcon,
    text: 'text-amber-500',
    bar: 'bg-amber-500',
  },
  {
    key: 'code',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'sh', 'py'],
    icon: FileCodeIcon,
    text: 'text-emerald-500',
    bar: 'bg-emerald-500',
  },
  {
    key: 'text',
    extensions: ['txt', 'md', 'mdx', 'csv', 'yaml', 'yml'],
    icon: FileTextIcon,
    text: 'text-sky-500',
    bar: 'bg-sky-500',
  },
]

const OTHER_KIND: FileKind = {
  key: 'other',
  icon: FileIcon,
  text: 'text-muted-foreground',
  bar: 'bg-muted-foreground/50',
}

export function fileKind(name: string): FileKind {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  return FILE_KINDS.find(kind => kind.extensions.includes(extension)) ?? OTHER_KIND
}

export function FileGlyph({
  entry,
  app,
  className = 'size-5',
}: {
  entry: Pick<DirectoryEntry, 'name' | 'isDirectory'>
  app?: { status: AppDisplayStatus }
  className?: string
}) {
  if (app !== undefined)
    return (
      <AppWindowIcon
        weight="duotone"
        className={`${className} ${statusClasses(app.status).tint}`}
      />
    )
  if (entry.isDirectory)
    return <FolderIcon weight="fill" className={`${className} text-amber-400`} />
  const kind = fileKind(entry.name)
  const KindIcon = kind.icon
  return <KindIcon weight="duotone" className={`${className} ${kind.text}`} />
}
