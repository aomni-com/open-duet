import { AGENT_INPUT_IMAGE_MIME_TYPES, type AgentInputImage } from '@repo/contract'

export const SESSION_IMAGE_ACCEPT = AGENT_INPUT_IMAGE_MIME_TYPES.join(',')

export async function encodeSessionImage(file: File): Promise<AgentInputImage> {
  if (!isAgentImageMimeType(file.type)) throw new Error('Unsupported session image type')
  return {
    data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    mimeType: file.type,
  }
}

function isAgentImageMimeType(
  mimeType: string,
): mimeType is (typeof AGENT_INPUT_IMAGE_MIME_TYPES)[number] {
  return AGENT_INPUT_IMAGE_MIME_TYPES.some(candidate => candidate === mimeType)
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024)))
  }
  return btoa(chunks.join(''))
}
