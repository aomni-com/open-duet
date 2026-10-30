import { describe, expect, test } from 'bun:test'

import { driveColumnChain } from './column-chain'

describe('driveColumnChain', () => {
  test('opens one column per ancestor, rooted at the drive root', () => {
    expect(driveColumnChain('/projects/reporting/q3')).toEqual([
      '/',
      '/projects',
      '/projects/reporting',
      '/projects/reporting/q3',
    ])
  })

  test('stands the root up as its own single column', () => {
    expect(driveColumnChain('/')).toEqual(['/'])
  })

  test('answers a malformed path with the root rather than throwing', () => {
    expect(driveColumnChain('/projects/../etc')).toEqual(['/'])
  })
})
