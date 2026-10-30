import type { FilesRow } from './app-rows'
import type { AppNavigator } from './apps-context'
import type { DirectoryEntry } from './lib/types'

export function activateFilesRow(
  row: FilesRow,
  {
    navigator,
    openEntry,
  }: {
    navigator: AppNavigator
    openEntry(entry: DirectoryEntry): void
  },
): void {
  if (row.app !== undefined) {
    navigator.openApp(row.app.app)
    return
  }
  openEntry(row.entry)
}

export function filesRowKey(row: FilesRow): string {
  return row.entry.path
}
