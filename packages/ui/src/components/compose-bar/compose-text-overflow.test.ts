import { expect, test } from 'bun:test'

import {
  COMPOSE_INLINE_TEXT_LIMIT,
  createComposeOverflowFileName,
  shouldAttachPastedText,
} from './compose-text-overflow'

test('turns only a paste that would exceed the inline limit into an attachment', () => {
  expect(
    shouldAttachPastedText({
      currentTextLength: COMPOSE_INLINE_TEXT_LIMIT - 100,
      pastedTextLength: 100,
    }),
  ).toBe(false)
  expect(
    shouldAttachPastedText({
      currentTextLength: COMPOSE_INLINE_TEXT_LIMIT - 100,
      pastedTextLength: 101,
    }),
  ).toBe(true)
  expect(
    shouldAttachPastedText({
      currentTextLength: COMPOSE_INLINE_TEXT_LIMIT,
      pastedTextLength: 0,
    }),
  ).toBe(false)
})

test('gives pasted text a stable human-readable txt name', () => {
  expect(createComposeOverflowFileName(new Date(2026, 7, 12, 14, 5, 9, 7))).toBe(
    'pasted-text-20260812-140509-007.txt',
  )
})
