/* ============================================================================
   What a column shows, and in what order.

   The two questions a column asks of its listing — which rows survive the
   toolbar, and how they are ordered — live here as pure functions over the
   already-projected `FilesRow`. Keeping them out of the presentation is what
   lets every column share one answer: the reference grew a second, competing
   filter once the rail and the toolbar each kept their own.

   Kind is read from `fileKind`, the drive's existing extension table, rather
   than a second one. The listing carries no MIME type, so the extension is the
   only honest signal available before a file is read.
   ========================================================================= */
import type { FilesRow } from './app-rows'
import { fileKind, type FileKindKey } from './file-glyph'

/**
 * The toolbar's sort keys.
 *
 * `size` is a Duet addition, not a port. The reference omitted it because its
 * file model carried no byte count; `FileEntry.size` is real here, so sorting
 * by it reports something true rather than a stand-in.
 */
export type DriveSortKey = 'name' | 'modified' | 'kind' | 'size'

export const DRIVE_SORT_KEYS: readonly DriveSortKey[] = ['name', 'modified', 'kind', 'size']
export const DEFAULT_DRIVE_SORT: DriveSortKey = 'name'

/**
 * The Show groups.
 *
 * The reference's `urls` chip is deliberately absent: Duet has no URL-file
 * metadata contract, so the group could only ever be empty or guess.
 */
export type DriveFilterGroup = 'all' | 'images' | 'docs' | 'code' | 'pdfs' | 'media'

export const DRIVE_FILTER_GROUPS: readonly DriveFilterGroup[] = [
  'all',
  'images',
  'docs',
  'code',
  'pdfs',
  'media',
]

const GROUP_KINDS: Record<Exclude<DriveFilterGroup, 'all'>, ReadonlySet<FileKindKey>> = {
  images: new Set<FileKindKey>(['image']),
  docs: new Set<FileKindKey>(['text', 'sheets', 'slides']),
  code: new Set<FileKindKey>(['code']),
  pdfs: new Set<FileKindKey>(['pdf']),
  media: new Set<FileKindKey>(['audio', 'video']),
}

export type DriveFilter = {
  group: DriveFilterGroup
  /** Case-insensitive name query from the toolbar; empty string means no search. */
  search: string
}

export const DEFAULT_DRIVE_FILTER: DriveFilter = { group: 'all', search: '' }

/** A row's name. */
export function driveRowName(row: FilesRow): string {
  return row.entry.name
}

function isFolderRow(row: FilesRow): boolean {
  return row.entry.isDirectory
}

/**
 * Whether a row survives the toolbar. Group and search **compose** — a row must
 * clear both.
 *
 * Folders ignore the group entirely, so picking Images never strands you in a
 * directory you can no longer drill out of. Search still trims them, because a
 * reader typing a query means the whole list, not just its files.
 */
export function driveRowMatches(row: FilesRow, filter: DriveFilter): boolean {
  const name = driveRowName(row)
  if (filter.group !== 'all' && !isFolderRow(row)) {
    if (!GROUP_KINDS[filter.group].has(fileKind(name).key)) return false
  }
  const query = filter.search.trim().toLowerCase()
  return query === '' || name.toLowerCase().includes(query)
}

/**
 * How many rows of the open folder belong to each group.
 *
 * The number beside "Images" answers "how many images are here", so it counts
 * files of that kind and nothing else. It deliberately does *not* count what
 * the group would leave on screen: folders clear every group so the reader is
 * never stranded, and folding that navigation rule into the tally printed a
 * folder count beside every kind — the same number six times, describing
 * nothing. Only All, which is the whole listing, counts them.
 */
export function driveGroupCounts(rows: readonly FilesRow[]): Record<DriveFilterGroup, number> {
  const counts = Object.fromEntries(DRIVE_FILTER_GROUPS.map(group => [group, 0])) as Record<
    DriveFilterGroup,
    number
  >
  counts.all = rows.length
  for (const row of rows) {
    if (isFolderRow(row)) continue
    const kind = fileKind(driveRowName(row)).key
    for (const [group, kinds] of Object.entries(GROUP_KINDS)) {
      if (kinds.has(kind)) counts[group as DriveFilterGroup] += 1
    }
  }
  return counts
}

function byName(left: FilesRow, right: FilesRow): number {
  return driveRowName(left).localeCompare(driveRowName(right))
}

function sizeOf(row: FilesRow): number {
  return row.entry.size ?? 0
}

function modifiedAt(row: FilesRow): number {
  return row.entry.modifiedAt?.getTime() ?? 0
}

/**
 * Order one column's rows.
 *
 * **Folders stay above files under every key**, the way a Finder column does,
 * and are themselves alphabetical: a directory listing carries no kind, and its
 * size and mtime describe the directory record rather than what is inside it, so
 * there is nothing honest to order them by. Only the file group answers to
 * `modified`, `kind`, and `size`, each falling back to name on a tie.
 */
export function sortDriveRows(rows: readonly FilesRow[], sort: DriveSortKey): FilesRow[] {
  const folders = rows.filter(isFolderRow).sort(byName)
  const files = rows.filter(row => !isFolderRow(row))

  files.sort((left, right) => {
    switch (sort) {
      case 'modified':
        return modifiedAt(right) - modifiedAt(left) || byName(left, right)
      case 'size':
        return sizeOf(right) - sizeOf(left) || byName(left, right)
      case 'kind':
        return (
          fileKind(driveRowName(left)).key.localeCompare(fileKind(driveRowName(right)).key) ||
          byName(left, right)
        )
      default:
        return byName(left, right)
    }
  })

  return [...folders, ...files]
}
