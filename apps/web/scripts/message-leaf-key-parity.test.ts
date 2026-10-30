import { describe, expect, test } from 'bun:test'

import enApp from '../messages/en/app.json'
import enAuth from '../messages/en/auth.json'
import esApp from '../messages/es-419/app.json'
import esAuth from '../messages/es-419/auth.json'

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('web message catalogs', () => {
  test.each([
    ['app.json', enApp, esApp],
    ['auth.json', enAuth, esAuth],
  ])('%s has matching English and Spanish leaf keys', (_file, english, spanish) => {
    expect(leafKeys(spanish).sort()).toEqual(leafKeys(english).sort())
  })
})
