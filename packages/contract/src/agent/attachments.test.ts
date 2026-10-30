import { describe, expect, test } from 'bun:test'

import { attachmentFileName, attachmentLandingPrefix } from './attachments'
import {
  AgentAnswerRequestSchema,
  AgentAnswerSubmittedEventSchema,
  AgentEventAttachmentSchema,
  AgentMessageRequestSchema,
  AgentNoteRequestSchema,
  AgentNoteSubmittedEventSchema,
  AgentPromptSubmittedEventSchema,
  AgentStartSessionRequestSchema,
} from './index'

describe('agent input attachments', () => {
  test('round-trips attachment metadata while tolerating future fields', () => {
    expect(
      AgentEventAttachmentSchema.parse({
        path: 'agents/designer/uploads/brand-guide.pdf',
        name: 'Brand Guide.pdf',
        bytes: 42,
        mimeType: 'application/pdf',
        futureField: 'ignored',
      }),
    ).toEqual({
      path: 'agents/designer/uploads/brand-guide.pdf',
      name: 'Brand Guide.pdf',
      bytes: 42,
      mimeType: 'application/pdf',
    })
  })

  test('rejects attachment paths that are not normalized drive-relative paths', () => {
    for (const path of [
      '../secret.txt',
      '/etc/passwd',
      'uploads/../secret.txt',
      'uploads//secret.txt',
      'uploads\\secret.txt',
      'uploads/\u0000secret.txt',
    ]) {
      expect(
        AgentEventAttachmentSchema.safeParse({ path, name: 'secret.txt', bytes: 1 }).success,
      ).toBe(false)
    }
  })

  test('carries attachments on every submitted input request and durable event', () => {
    const attachments = [{ path: 'uploads/brief.pdf', name: 'Brief.pdf', bytes: 42 }]
    const cases = [
      [AgentStartSessionRequestSchema, { prompt: 'start' }],
      [AgentMessageRequestSchema, { prompt: 'continue' }],
      [AgentNoteRequestSchema, { note: 'context' }],
      [AgentAnswerRequestSchema, { answer: 'approved' }],
      [
        AgentPromptSubmittedEventSchema,
        {
          type: 'prompt_submitted',
          prompt: 'continue',
          inputKind: 'message',
          behavior: 'steer',
          sender: { kind: 'system' },
        },
      ],
      [
        AgentNoteSubmittedEventSchema,
        { type: 'note_submitted', note: 'context', sender: { kind: 'system' } },
      ],
      [
        AgentAnswerSubmittedEventSchema,
        { type: 'answer_submitted', answer: 'approved', sender: { kind: 'system' } },
      ],
    ] as const

    for (const [schema, input] of cases) {
      expect(schema.parse({ ...input, attachments })).toMatchObject({ attachments })
    }
  })

  test('caps one input at ten attachments', () => {
    const attachments = Array.from({ length: 11 }, (_, index) => ({
      path: `uploads/file-${index}.txt`,
      name: `file-${index}.txt`,
      bytes: index,
    }))

    expect(AgentMessageRequestSchema.safeParse({ prompt: 'read these', attachments }).success).toBe(
      false,
    )
    expect(
      AgentMessageRequestSchema.safeParse({
        prompt: 'read these',
        attachments: attachments.slice(1),
      }).success,
    ).toBe(true)
  })
})

describe('session attachment upload contract', () => {
  test('lands files in one flat uploads folder beneath the agent cwd', () => {
    expect(attachmentLandingPrefix({})).toBe('uploads')
    expect(attachmentLandingPrefix({ cwd: 'agents/research' })).toBe('agents/research/uploads')
  })

  test('makes hidden and filesystem-trimmed names visible in the Files surface', () => {
    expect(attachmentFileName('...quarterly report.pdf. ')).toBe('quarterly report.pdf')
    expect(attachmentFileName('..folder\\report\u0000.pdf')).toBe('folder-report-.pdf')
  })

  test('UTF-8 truncates the stem while preserving the extension and collision suffix room', () => {
    const filename = attachmentFileName(`${'界'.repeat(100)}.presentation.pdf`)

    expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(251)
    expect(filename).toEndWith('.pdf')
    expect(
      new TextEncoder().encode(filename.replace(/\.pdf$/, ' (2).pdf')).byteLength,
    ).toBeLessThanOrEqual(255)
    expect(filename.endsWith('\ufffd.pdf')).toBe(false)
  })
})
