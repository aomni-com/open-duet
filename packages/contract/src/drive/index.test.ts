import { describe, expect, test } from 'bun:test'

import {
  noisyTreeRoot,
  DRIVE_ROOT_PATH,
  DRIVE_UPLOAD_MAX_BYTES,
  MAX_DRIVE_PATH_UTF8_BYTES,
  exceedsDriveUploadLimit,
  isDrivePathWithin,
  isPathInside,
  normalizeDrivePath,
  normalizeDriveUrlPath,
} from './index'

describe('noisy tree root', () => {
  test('returns the earliest normalized derived or .git segment root', () => {
    expect(noisyTreeRoot('apps/web/node_modules/pkg/.git/object')).toBe('apps/web/node_modules')
    expect(noisyTreeRoot('apps\\web//.git/objects/aa')).toBe('apps/web/.git')
  })

  test('matches every derived-content segment exactly', () => {
    for (const segment of [
      'node_modules',
      '__pycache__',
      '.venv',
      '.next',
      '.nuxt',
      '.output',
      '.svelte-kit',
      '.astro',
      '.angular',
      '.turbo',
      '.parcel-cache',
      '.vite',
      '.cache',
      '.gradle',
      '.pytest_cache',
      '.mypy_cache',
      '.ruff_cache',
    ]) {
      expect(noisyTreeRoot(`src/${segment}/nested/file`), segment).toBe(`src/${segment}`)
    }
  })

  test('does not classify authored or merely similar segment names', () => {
    for (const path of [
      'dist/file',
      'build/file',
      'out/file',
      'target/file',
      'vendor/file',
      'coverage/file',
      '.github/workflow.yml',
      'node_modules_backup/file',
      'src/.gitignore',
    ]) {
      expect(noisyTreeRoot(path), path).toBeNull()
    }
  })
})

describe('drive root path contract', () => {
  test('preserves literal percent bytes in logical drive paths', () => {
    expect(normalizeDrivePath('100%.pdf')).toEqual({
      ok: true,
      relativePath: '100%.pdf',
      absolutePath: `${DRIVE_ROOT_PATH}/100%.pdf`,
    })
  })

  test('decodes each raw URL segment exactly once', () => {
    expect(normalizeDriveUrlPath('a%252Fb/100%25.pdf')).toEqual({
      ok: true,
      relativePath: 'a%2Fb/100%.pdf',
      absolutePath: `${DRIVE_ROOT_PATH}/a%2Fb/100%.pdf`,
    })
    expect(normalizeDriveUrlPath('%252e%252e/secret')).toEqual({
      ok: true,
      relativePath: '%2e%2e/secret',
      absolutePath: `${DRIVE_ROOT_PATH}/%2e%2e/secret`,
    })
  })

  test('rejects URL-decoded traversal, separators, reserved paths, and malformed bytes', () => {
    for (const path of [
      '%2e%2e/secret',
      'safe%2F..%2Fsecret',
      'safe%5C..%5Csecret',
      '%2Fetc/passwd',
      'C%3A/Windows/system.ini',
      '%2eduet/token',
      'safe/%00/token',
      'safe/%GG/token',
    ]) {
      expect(normalizeDriveUrlPath(path).ok, path).toBe(false)
    }
  })

  test('normalizes logical paths under the drive root without decoding filename bytes', () => {
    expect(normalizeDrivePath('notes/today%20plan.txt')).toEqual({
      ok: true,
      relativePath: 'notes/today%20plan.txt',
      absolutePath: `${DRIVE_ROOT_PATH}/notes/today%20plan.txt`,
    })
    expect(normalizeDrivePath('', { allowRoot: true })).toEqual({
      ok: true,
      relativePath: '',
      absolutePath: DRIVE_ROOT_PATH,
    })
  })

  test('bounds logical paths by persisted UTF-8 bytes', () => {
    expect(normalizeDrivePath('a'.repeat(MAX_DRIVE_PATH_UTF8_BYTES)).ok).toBe(true)
    expect(normalizeDrivePath(`${'a'.repeat(MAX_DRIVE_PATH_UTF8_BYTES - 3)}🚀`)).toEqual({
      ok: false,
      reason: 'too_long',
    })
  })

  test('rejects traversal, absolute paths, and reserved state paths', () => {
    for (const path of [
      '../secret',
      '/home/exedev/.duet/vm-token',
      'C:/Users/exedev/drive/file',
      'safe/\0/token',
      '.duet/vm-token',
      'safe/.duet/token',
      '.duet-anchor',
      'safe/.duet-anchor',
    ]) {
      expect(normalizeDrivePath(path).ok, path).toBe(false)
    }
  })

  test('checks lexical drive path containment without sibling prefix leaks', () => {
    expect(isDrivePathWithin('shared/reports', 'shared/reports')).toBe(true)
    expect(isDrivePathWithin('shared/reports', 'shared/reports/q2.md')).toBe(true)
    expect(isDrivePathWithin('shared/reports', 'shared/reports-old/q2.md')).toBe(false)
    expect(isDrivePathWithin('', 'anything')).toBe(false)
  })

  test('checks resolved filesystem path containment', () => {
    expect(isPathInside('/drive', '/drive')).toBe(true)
    expect(isPathInside('/drive', '/drive/reports/q2.md')).toBe(true)
    expect(isPathInside('/drive', '/drive/..drafts/q2.md')).toBe(true)
    expect(isPathInside('/drive', '/drive-old/q2.md')).toBe(false)
  })
})

describe('per-file upload limit', () => {
  // The boundary is the whole content of this rule, and three callers ask it —
  // the VM route and both browser surfaces. Written out three times it would be
  // three chances to disagree about which side of the line the cap sits on.
  test('admits a file exactly at the limit and refuses the next byte', () => {
    expect(exceedsDriveUploadLimit(0)).toBe(false)
    expect(exceedsDriveUploadLimit(DRIVE_UPLOAD_MAX_BYTES - 1)).toBe(false)
    expect(exceedsDriveUploadLimit(DRIVE_UPLOAD_MAX_BYTES)).toBe(false)
    expect(exceedsDriveUploadLimit(DRIVE_UPLOAD_MAX_BYTES + 1)).toBe(true)
  })

  // Decimal, because the files surfaces render base-1000: a binary cap would
  // print as 34.4 GB, and a refusal quoting 34.4 GB about a 33 GB file reads as
  // a bug. See `apps/web/spa/format.ts`.
  test('is a round decimal number of bytes', () => {
    expect(DRIVE_UPLOAD_MAX_BYTES % 1_000_000_000).toBe(0)
  })
})
