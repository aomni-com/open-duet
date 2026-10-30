/* ============================================================================
   What a key press means in the column stack.

   Kept pure and away from the component for two reasons: traversal is the part
   of a Miller browser that is genuinely easy to get subtly wrong (walking back
   out of a column is *re-opening the folder that column lists*, not "go up"),
   and the drive has no DOM test harness — a reducer can be pinned exactly,
   where an event handler could only be pinned through rendered markup.
   ========================================================================= */

export type KeyRow = {
  path: string
  /**
   * `app` is a folder an app is anchored to: activating it opens the app, the
   * way clicking it does.
   */
  kind: 'folder' | 'file' | 'app'
}

export type KeyColumn = {
  /** The folder this column lists. */
  dir: string
  rows: readonly KeyRow[]
}

export type ColumnKeyAction = {
  /** Which column holds keyboard focus after this key. */
  focusColumn: number
  navigate?:
    | { kind: 'folder'; path: string }
    | { kind: 'file-select'; path: string }
    | { kind: 'file-open'; path: string }
    | { kind: 'app'; path: string }
}

/**
 * The action a key produces, or `null` when the drive should let the key through
 * untouched — which is also the signal not to call `preventDefault`.
 *
 * Up/Down move within the focused column and *activate* what they land on, the
 * way a Finder column does: a folder opens its column to the right, a file takes
 * the preview. Right drills into an already-selected folder, Left walks back out,
 * and Enter opens the selected file fully.
 */
export function driveColumnsKeyAction(
  key: string,
  state: {
    columns: readonly KeyColumn[]
    activeColumnIndex: number
    selectedPath: string | null
  },
): ColumnKeyAction | null {
  const { columns, activeColumnIndex, selectedPath } = state
  const active = columns[activeColumnIndex]
  if (active === undefined) return null
  const rows = active.rows
  const selected = rows.find(row => row.path === selectedPath)

  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (rows.length === 0) return null
      const current = rows.findIndex(row => row.path === selectedPath)
      const next =
        key === 'ArrowDown'
          ? Math.min(rows.length - 1, current + 1)
          : Math.max(0, current <= 0 ? 0 : current - 1)
      const row = rows[next]
      if (row === undefined) return null
      return activation(row, activeColumnIndex)
    }
    case 'ArrowRight': {
      /* Right enters the *folder*, including an app's anchor folder — the one
         gesture that distinguishes going inside an app from opening it. */
      if (selected?.kind !== 'folder' && selected?.kind !== 'app') return null
      return {
        focusColumn: activeColumnIndex + 1,
        navigate: { kind: 'folder', path: selected.path },
      }
    }
    case 'ArrowLeft': {
      if (activeColumnIndex === 0) return null
      /* A column's own folder is exactly the row highlighted one column to its
         left, so walking back out is re-opening that folder — which both
         re-selects it and truncates everything deeper. */
      return {
        focusColumn: activeColumnIndex - 1,
        navigate: { kind: 'folder', path: active.dir },
      }
    }
    case 'Enter': {
      if (selected?.kind === 'app') {
        return { focusColumn: activeColumnIndex, navigate: { kind: 'app', path: selected.path } }
      }
      if (selected?.kind !== 'file') return null
      return {
        focusColumn: activeColumnIndex,
        navigate: { kind: 'file-open', path: selected.path },
      }
    }
    default:
      return null
  }
}

function activation(row: KeyRow, columnIndex: number): ColumnKeyAction {
  if (row.kind === 'app') {
    return { focusColumn: columnIndex, navigate: { kind: 'app', path: row.path } }
  }
  return {
    focusColumn: columnIndex,
    navigate:
      row.kind === 'folder'
        ? { kind: 'folder', path: row.path }
        : { kind: 'file-select', path: row.path },
  }
}
