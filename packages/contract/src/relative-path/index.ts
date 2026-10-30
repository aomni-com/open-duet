import { z } from 'zod'

export function isSafeRelativePath(path: string): boolean {
  const hasControlCharacter = Array.from(path).some(character => {
    const codeUnit = character.charCodeAt(0)
    return codeUnit <= 0x1f || codeUnit === 0x7f
  })
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    hasControlCharacter
  ) {
    return false
  }
  const segments = path.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

export const SafeRelativePathSchema = z
  .string()
  .refine(isSafeRelativePath, 'Expected a safe relative path')

/**
 * Icons are stored inline on agent and app rows that bounded workspace reads
 * collect together. Keep one byte ceiling for both writers so a valid icon
 * path cannot consume an unbounded share of those read budgets.
 */
export const MAX_ICON_PATH_UTF8_BYTES = 1_024
export const IconPathSchema = z
  .string()
  .trim()
  .refine(value => new TextEncoder().encode(value).byteLength <= MAX_ICON_PATH_UTF8_BYTES, {
    message: `Icon path exceeds ${MAX_ICON_PATH_UTF8_BYTES} UTF-8 bytes`,
  })
  .pipe(SafeRelativePathSchema)
