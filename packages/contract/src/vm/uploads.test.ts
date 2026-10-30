import { describe, expect, test } from 'bun:test'

import { vmUploadUrl, type VmUploadGrant } from './uploads'

const GRANT: VmUploadGrant = {
  vmBaseUrl: 'https://vm-abc123.exe.dev',
  uploadPath: '/v1/train/uploads',
  uploadToken: 'tok_test',
  expiresAt: 1_760_000_000_000,
}

describe('vm upload target', () => {
  test('joins the grant to an encoded filename', () => {
    expect(vmUploadUrl(GRANT, 'operating-notes.md')).toBe(
      'https://vm-abc123.exe.dev/v1/train/uploads/operating-notes.md',
    )
  })

  test('tolerates a base URL with or without a trailing slash', () => {
    // The grant is minted from a VM's public proxy URL, and whether that
    // carries a trailing slash is not something a caller should have to think
    // about — `new URL` would otherwise resolve the path against the parent.
    expect(vmUploadUrl({ ...GRANT, vmBaseUrl: 'https://vm-abc123.exe.dev/' }, 'notes.md')).toBe(
      vmUploadUrl(GRANT, 'notes.md'),
    )
  })

  test('encodes a filename that would otherwise change the path', () => {
    // A filename is one path segment. Spaces, and anything that looks like a
    // separator or a query, must not be able to retarget the request.
    expect(vmUploadUrl(GRANT, 'q2 plan.md')).toBe(
      'https://vm-abc123.exe.dev/v1/train/uploads/q2%20plan.md',
    )
    expect(vmUploadUrl(GRANT, '../escape.md')).toBe(
      'https://vm-abc123.exe.dev/v1/train/uploads/..%2Fescape.md',
    )
    expect(vmUploadUrl(GRANT, 'a?b=1.md')).toBe(
      'https://vm-abc123.exe.dev/v1/train/uploads/a%3Fb%3D1.md',
    )
  })
})
