import { describe, expect, test } from 'bun:test'

import { TrainStartRequestSchema } from './index'
import {
  GatewayTrainJobReportSchema,
  MAX_TRAIN_INLINE_BYTES,
  parseScrapedUrlFrontmatter,
  sanitizeUploadFilename,
  serializeScrapedUrlFrontmatter,
  TrainJobStatusSchema,
  TrainUploadSessionSchema,
  TrainUrlUploadRequestSchema,
  urlToUploadFilename,
} from './index'

describe('train uploads contract vocabulary', () => {
  test('includes the exact VM upload path in upload sessions', () => {
    const session = {
      vmBaseUrl: 'https://workspace.example.com',
      uploadPath: '/v1/train/uploads',
      uploadToken: 'upload-token',
      expiresAt: 1_700_000_000_000,
    }

    expect(TrainUploadSessionSchema.parse(session)).toEqual(session)
  })

  test('accepts an optional agent identity in train job statuses', () => {
    const status = {
      jobId: 'train_1',
      workspaceId: 'workspace_1',
      userId: 'user_1',
      agentId: 'agent_1',
      state: 'running' as const,
      phase: 'training' as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
    }

    expect(TrainJobStatusSchema.parse(status)).toEqual(status)
  })

  test('preserves one logical filename segment and rejects path attacks', () => {
    expect(sanitizeUploadFilename('quarterly%20report.pdf')).toBe('quarterly%20report.pdf')
    expect(sanitizeUploadFilename('%2e%2e%2fsecret')).toBe('%2e%2e%2fsecret')

    for (const attack of [
      '../secret',
      'safe/../secret',
      'safe\\secret',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'safe\0secret',
      '',
    ]) {
      expect(() => sanitizeUploadFilename(attack), attack).toThrow()
    }
  })

  test('round-trips frontmatter whose title contains YAML-significant text', () => {
    const frontmatter = {
      url: 'https://example.com/docs?topic=a:b#section',
      title: 'A "quoted" title:\n---\nadmin: true # nope',
      scrapedAt: '2026-07-15T09:10:11.000Z',
    }
    const artifact = serializeScrapedUrlFrontmatter(frontmatter, '# Body\n\nExact markdown.')

    expect(parseScrapedUrlFrontmatter(artifact)).toEqual(frontmatter)
    expect(artifact.endsWith('# Body\n\nExact markdown.')).toBe(true)
  })

  test('uses a deterministic slug and hash to disambiguate URL fixtures', () => {
    const first = 'https://example.com/docs/getting-started?lang=en'
    const second = 'https://example.com/docs/getting-started?lang=es'
    const firstFilename = urlToUploadFilename(first)

    expect(urlToUploadFilename(first)).toBe(firstFilename)
    expect(firstFilename).toMatch(/^url-example-com-docs-getting-started-[0-9a-f]{8}\.md$/)
    expect(urlToUploadFilename(second)).not.toBe(firstFilename)
    expect(sanitizeUploadFilename('example-com-docs-getting-started.md')).not.toBe(firstFilename)
  })

  test('accepts only absolute HTTP or HTTPS URL upload requests', () => {
    expect(TrainUrlUploadRequestSchema.parse({ url: 'https://example.com/docs' })).toEqual({
      url: 'https://example.com/docs',
    })
    for (const url of ['not a url', '/relative', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(TrainUrlUploadRequestSchema.safeParse({ url }).success, url).toBe(false)
    }
  })

  test('refuses hosts a training fetch must never reach', () => {
    // `assertPublicHttpUrl` encoded this policy and was exercised only by its
    // own unit test — nothing on the request path called it, so the boundary
    // accepted every one of these. The schema is where a user-supplied URL is
    // actually judged, so the policy lives here now.
    for (const url of [
      'http://localhost/admin',
      'http://LOCALHOST:8080/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://0.0.0.0/',
    ]) {
      expect(TrainUrlUploadRequestSchema.safeParse({ url }).success, url).toBe(false)
    }
    // Credentials are STRIPPED rather than refused — the policy's own choice —
    // so the parsed value must not still carry them.
    expect(
      TrainUrlUploadRequestSchema.parse({ url: 'https://user:pass@example.com/path' }),
    ).toEqual({ url: 'https://example.com/path' })
    // An ordinary public URL still passes untouched.
    expect(TrainUrlUploadRequestSchema.parse({ url: 'https://example.com/a?b=1' })).toEqual({
      url: 'https://example.com/a?b=1',
    })
  })

  test('accepts a bodyless-folder start and drive file references', () => {
    expect(TrainStartRequestSchema.parse({})).toEqual({})
    expect(TrainStartRequestSchema.parse({ driveFiles: ['reports/q2.pdf'] })).toEqual({
      driveFiles: ['reports/q2.pdf'],
    })
  })

  test('caps inline files by decoded raw bytes', () => {
    const atCap = Buffer.alloc(MAX_TRAIN_INLINE_BYTES, 0xff).toString('base64')
    const overCap = Buffer.alloc(MAX_TRAIN_INLINE_BYTES + 1, 0xff).toString('base64')

    expect(
      TrainStartRequestSchema.safeParse({
        files: [{ filename: 'binary.dat', content: atCap, encoding: 'base64' }],
      }).success,
    ).toBe(true)
    expect(
      TrainStartRequestSchema.safeParse({
        files: [{ filename: 'binary.dat', content: overCap, encoding: 'base64' }],
      }).success,
    ).toBe(false)
  })

  test('accepts phase-based gateway reports and strips legacy numeric progress', () => {
    const report = {
      generation: 'train_1:4',
      jobId: 'train_1',
      creatorUserId: 'user_1',
      agentId: 'agent_1',
      state: 'running' as const,
      phase: 'training' as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
      startedAt: 1_700_000_001_000,
    }

    expect(GatewayTrainJobReportSchema.parse(report)).toEqual(report)
    expect(GatewayTrainJobReportSchema.parse({ ...report, progress: 50 })).toEqual(report)
  })
})
