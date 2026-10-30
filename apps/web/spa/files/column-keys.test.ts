import { describe, expect, test } from 'bun:test'

import { driveColumnsKeyAction, type KeyColumn } from './column-keys'

/* Root holds two folders and a file; `/notes` is open into the second column. */
const columns: KeyColumn[] = [
  {
    dir: '/',
    rows: [
      { path: '/archive', kind: 'folder' },
      { path: '/notes', kind: 'folder' },
      { path: '/readme.md', kind: 'file' },
    ],
  },
  {
    dir: '/notes',
    rows: [
      { path: '/notes/draft.md', kind: 'file' },
      { path: '/notes/final.md', kind: 'file' },
    ],
  },
]

describe('driveColumnsKeyAction', () => {
  test('ArrowRight on a selected folder opens it and moves focus into the new column', () => {
    expect(
      driveColumnsKeyAction('ArrowRight', {
        columns,
        activeColumnIndex: 0,
        selectedPath: '/notes',
      }),
    ).toEqual({ focusColumn: 1, navigate: { kind: 'folder', path: '/notes' } })
  })

  test('ArrowLeft walks back out by re-opening the folder the column lists', () => {
    expect(
      driveColumnsKeyAction('ArrowLeft', {
        columns,
        activeColumnIndex: 1,
        selectedPath: '/notes/draft.md',
      }),
    ).toEqual({ focusColumn: 0, navigate: { kind: 'folder', path: '/notes' } })
  })

  test('ArrowLeft at the root is not the drive’s key to take', () => {
    expect(
      driveColumnsKeyAction('ArrowLeft', { columns, activeColumnIndex: 0, selectedPath: '/notes' }),
    ).toBeNull()
  })

  test('ArrowDown onto a folder opens its column, onto a file only selects it', () => {
    expect(
      driveColumnsKeyAction('ArrowDown', {
        columns,
        activeColumnIndex: 0,
        selectedPath: '/archive',
      }),
    ).toEqual({ focusColumn: 0, navigate: { kind: 'folder', path: '/notes' } })

    expect(
      driveColumnsKeyAction('ArrowDown', { columns, activeColumnIndex: 0, selectedPath: '/notes' }),
    ).toEqual({ focusColumn: 0, navigate: { kind: 'file-select', path: '/readme.md' } })
  })

  test('ArrowDown stops at the last row instead of wrapping', () => {
    expect(
      driveColumnsKeyAction('ArrowDown', {
        columns,
        activeColumnIndex: 0,
        selectedPath: '/readme.md',
      }),
    ).toEqual({ focusColumn: 0, navigate: { kind: 'file-select', path: '/readme.md' } })
  })

  test('Enter opens the selected file; ArrowRight refuses to drill one', () => {
    const state = { columns, activeColumnIndex: 1, selectedPath: '/notes/final.md' }
    expect(driveColumnsKeyAction('Enter', state)).toEqual({
      focusColumn: 1,
      navigate: { kind: 'file-open', path: '/notes/final.md' },
    })
    expect(driveColumnsKeyAction('ArrowRight', state)).toBeNull()
  })

  test('an app row opens its app, with or without a folder behind it', () => {
    const apps: KeyColumn[] = [
      {
        dir: '/',
        rows: [
          { path: '/here', kind: 'file' },
          { path: '/hello', kind: 'app' },
        ],
      },
    ]
    // Arrowing onto an app opens it, exactly as clicking it does.
    expect(
      driveColumnsKeyAction('ArrowDown', {
        columns: apps,
        activeColumnIndex: 0,
        selectedPath: '/here',
      }),
    ).toEqual({ focusColumn: 0, navigate: { kind: 'app', path: '/hello' } })

    // Right is the one gesture that goes *inside* an app rather than opening it.
    expect(
      driveColumnsKeyAction('ArrowRight', {
        columns: apps,
        activeColumnIndex: 0,
        selectedPath: '/hello',
      }),
    ).toEqual({ focusColumn: 1, navigate: { kind: 'folder', path: '/hello' } })
  })

  test('an unhandled key is left alone', () => {
    expect(
      driveColumnsKeyAction('Tab', { columns, activeColumnIndex: 0, selectedPath: '/notes' }),
    ).toBeNull()
  })
})
