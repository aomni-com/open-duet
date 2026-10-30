import { expect, test } from 'bun:test'

import { resolvePreviewPresentation, type PreviewMode } from './preview-presentation'

const EDITABLE: PreviewMode = { access: 'editable', textPresentation: 'rich', attribution: 'show' }
const READONLY: PreviewMode = {
  access: 'read-only',
  textPresentation: 'source',
  attribution: 'hide',
}

const MB = 1024 * 1024

test('SVG is an image in rich mode but text in source mode', () => {
  const rich = resolvePreviewPresentation('logo.svg', 400, EDITABLE)
  expect(rich.isText).toBe(false)
  expect(rich.binary).toBe('image')

  const source = resolvePreviewPresentation('logo.svg', 400, READONLY)
  expect(source.isText).toBe(true)
  expect(source.binary).toBe(null)
})

test('Markdown renders with a toggle in rich mode and is forced to source in source mode', () => {
  expect(resolvePreviewPresentation('readme.md', 100, EDITABLE).markdown).toBe('toggle')
  expect(resolvePreviewPresentation('readme.md', 100, READONLY).markdown).toBe('source')
  // Non-markdown text never gets the markdown toggle.
  expect(resolvePreviewPresentation('notes.txt', 100, EDITABLE).markdown).toBe('none')
})

test('read-only access disables editable and autosave presentation policies for text', () => {
  const editable = resolvePreviewPresentation('notes.txt', 100, EDITABLE)
  expect(editable.isText).toBe(true)
  expect(editable.editable).toBe(true)
  expect(editable.autosaves).toBe(true)

  const readOnly = resolvePreviewPresentation('notes.txt', 100, READONLY)
  expect(readOnly.isText).toBe(true)
  expect(readOnly.editable).toBe(false)
  expect(readOnly.autosaves).toBe(false)
})

test('hidden attribution disables history and seen-by presentation policies', () => {
  const shown = resolvePreviewPresentation('notes.txt', 100, EDITABLE)
  expect(shown.showHistory).toBe(true)
  expect(shown.showSeenBy).toBe(true)

  const hidden = resolvePreviewPresentation('notes.txt', 100, READONLY)
  expect(hidden.showHistory).toBe(false)
  expect(hidden.showSeenBy).toBe(false)
})

test('media viewers render in both modes', () => {
  for (const mode of [EDITABLE, READONLY]) {
    expect(resolvePreviewPresentation('photo.png', 900, mode).binary).toBe('image')
    expect(resolvePreviewPresentation('brief.pdf', 900, mode).binary).toBe('pdf')
    expect(resolvePreviewPresentation('clip.mp4', 900, mode).binary).toBe('video')
    expect(resolvePreviewPresentation('song.mp3', 900, mode).binary).toBe('audio')
    expect(resolvePreviewPresentation('data.bin', 900, mode).binary).toBe('hex')
  }
})

test('office renders inline under the 25 MB ceiling and falls back to download over it', () => {
  const under = resolvePreviewPresentation('plan.xlsx', 24 * MB, READONLY)
  expect(under.binary).toBe('office')
  expect(under.officeFallback).toBe('none')
  expect(under.loadStrategy).toBe('versioned')

  const over = resolvePreviewPresentation('plan.xlsx', 26 * MB, READONLY)
  expect(over.binary).toBe('office')
  expect(over.officeFallback).toBe('too-large')
  // Over the ceiling we sniff a range instead of decoding the whole file.
  expect(over.loadStrategy).toBe('range')
})

test('office with an unknown size never guesses that a full decode is safe', () => {
  const unknown = resolvePreviewPresentation('plan.xlsx', undefined, READONLY)

  expect(unknown.binary).toBe('office')
  expect(unknown.officeFallback).toBe('unknown-size')
  expect(unknown.loadStrategy).toBe('range')
})

test('text loads the whole file; non-text binaries sniff a range', () => {
  expect(resolvePreviewPresentation('notes.txt', 100, EDITABLE).loadStrategy).toBe('versioned')
  expect(resolvePreviewPresentation('photo.png', 100, EDITABLE).loadStrategy).toBe('range')
  // SVG follows its mode: whole file as source text, range as a rich image.
  expect(resolvePreviewPresentation('logo.svg', 100, READONLY).loadStrategy).toBe('versioned')
  expect(resolvePreviewPresentation('logo.svg', 100, EDITABLE).loadStrategy).toBe('range')
})
