import { describe, expect, test } from 'bun:test'

import { FileDownloadRequestSchema, FileUploadRequestSchema } from './index'

describe('file transfer contract', () => {
  test('targets normalized Drive paths, and the root only where it means a folder', () => {
    expect(FileDownloadRequestSchema.parse({ path: 'mcp/generated-media/clip.mp4' })).toEqual({
      path: 'mcp/generated-media/clip.mp4',
    })
    expect(FileUploadRequestSchema.parse({ pathPrefix: 'mcp/generated-media' })).toEqual({
      pathPrefix: 'mcp/generated-media',
    })

    for (const path of ['/mcp/file.txt', 'mcp//file.txt', 'mcp/../secret']) {
      expect(FileDownloadRequestSchema.safeParse({ path }).success, path).toBe(false)
      expect(FileUploadRequestSchema.safeParse({ pathPrefix: path }).success, path).toBe(false)
    }

    /* The two differ on exactly one value. A download names a file, and no file
       is the drive root — but an upload names the folder to land in, and the
       root is the folder the files tab uses whenever nobody has navigated into
       one. This test previously required "non-root" of both, which was true
       while the only caller was MCP generated media and always a subfolder. */
    expect(FileDownloadRequestSchema.safeParse({ path: '' }).success).toBe(false)
    expect(FileUploadRequestSchema.parse({ pathPrefix: '' })).toEqual({ pathPrefix: '' })

    expect(
      FileDownloadRequestSchema.safeParse({ path: 'clip.mp4', pathPrefix: 'elsewhere' }).success,
    ).toBe(false)
    expect(
      FileUploadRequestSchema.safeParse({ pathPrefix: 'mcp', path: 'elsewhere/clip.mp4' }).success,
    ).toBe(false)
  })
})
