import { describe, expect, test } from 'bun:test'

import { findMojibake } from './public-text-integrity'

describe('public text integrity', () => {
  test.each([
    'workaroundsâif',
    'volume Ã CTR',
    'revenue Ã· cost',
    'Sourced â Screen',
    'bad\u0094dash',
    'lost � glyph',
  ])('finds visible encoding damage: %s', text => {
    expect(findMojibake(text)).not.toEqual([])
  })

  test.each([
    'Las sesiones guardan archivos, historial y contexto.',
    'An em dash — and arrows → render directly.',
    'Spec-driven meta-prompting system by TÂCHES.',
  ])('allows valid Unicode and the exact TÂCHES name: %s', text => {
    expect(findMojibake(text)).toEqual([])
  })
})
