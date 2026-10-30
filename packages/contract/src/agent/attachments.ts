import { z } from 'zod'

import { normalizeDrivePath } from '../drive/index'

export const AGENT_INPUT_ATTACHMENT_MAX_COUNT = 10

export const AgentEventAttachmentSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(path => {
      const normalized = normalizeDrivePath(path)
      return normalized.ok && normalized.relativePath === path
    }, 'attachment path must be a normalized drive path'),
  name: z.string().min(1).max(255),
  bytes: z.number().int().min(0),
  mimeType: z.string().min(1).optional(),
})
export type AgentEventAttachment = z.infer<typeof AgentEventAttachmentSchema>

export function attachmentLandingPrefix(input: { cwd?: string }): string {
  return input.cwd === undefined ? 'uploads' : `${input.cwd}/uploads`
}

export function attachmentFileName(name: string): string {
  const cleaned =
    name
      // oxlint-disable-next-line no-control-regex -- filenames cannot carry Drive path controls
      .replace(/[\\/\u0000-\u001f\u007f]/g, '-')
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '') || 'file'
  const maxBytes = 255 - new TextEncoder().encode(' (2)').byteLength
  const extensionStart = cleaned.lastIndexOf('.')
  const extension = extensionStart > 0 ? cleaned.slice(extensionStart) : ''
  const stem = extensionStart > 0 ? cleaned.slice(0, extensionStart) : cleaned
  const extensionBytes = utf8Bytes(extension)
  if (extensionBytes >= maxBytes) return truncateUtf8(cleaned, maxBytes)
  return `${truncateUtf8(stem, maxBytes - extensionBytes)}${extension}`
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = utf8Bytes(character)
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
