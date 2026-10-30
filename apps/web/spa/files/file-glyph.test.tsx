import { expect, test } from 'bun:test'

import { AppWindowIcon, FilePptIcon, FolderIcon } from '@phosphor-icons/react'

import { FileGlyph } from './file-glyph'

const folder = {
  name: 'hello',
  path: '/hello',
  isDirectory: true,
}

test('app folders replace the folder glyph and inherit the shared status tint', () => {
  const appGlyph = FileGlyph({
    entry: folder,
    app: { status: 'reconciled' },
  })
  const ordinaryGlyph = FileGlyph({ entry: folder })

  expect(appGlyph.type).toBe(AppWindowIcon)
  expect(appGlyph.props.className).toContain('text-emerald-500')
  expect(ordinaryGlyph.type).toBe(FolderIcon)
  expect(ordinaryGlyph.props.className).toContain('text-amber-400')
})

test('PowerPoint files use a presentation-specific glyph', () => {
  const glyph = FileGlyph({ entry: { ...folder, name: 'deck.pptx', isDirectory: false } })

  expect(glyph.type).toBe(FilePptIcon)
})
