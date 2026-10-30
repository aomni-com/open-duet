import { assertSafeAnchorSegment } from '../agents/agent-context'

export type UploadScope = { kind: 'root' } | { kind: 'agent'; anchorId: string }

export const ROOT_UPLOAD_SCOPE: UploadScope = { kind: 'root' }

export class InvalidUploadScopeError extends Error {
  constructor() {
    super('Invalid agent anchor id')
    this.name = 'InvalidUploadScopeError'
  }
}

export function agentUploadScope(anchorId: string): UploadScope {
  return { kind: 'agent', anchorId: validatedAgentAnchorId(anchorId) }
}

function validatedAgentAnchorId(anchorId: string): string {
  try {
    assertSafeAnchorSegment(anchorId)
  } catch {
    throw new InvalidUploadScopeError()
  }
  if (anchorId === 'root') throw new InvalidUploadScopeError()
  return anchorId
}

export function uploadScopeKey(scope: UploadScope): string {
  return scope.kind === 'root' ? 'root' : validatedAgentAnchorId(scope.anchorId)
}

export function trainUploadsPath(scope: UploadScope): string {
  return scope.kind === 'root'
    ? '/v1/train/uploads'
    : `/v1/train/agents/${encodeURIComponent(uploadScopeKey(scope))}/uploads`
}

export function uploadScopeForPath(path: string): UploadScope | null {
  if (path === '/v1/train/uploads' || path.startsWith('/v1/train/uploads/')) {
    return ROOT_UPLOAD_SCOPE
  }
  const match = path.match(/^\/v1\/train\/agents\/([^/]+)\/uploads(?:\/|$)/)
  if (match === null) return null
  try {
    return agentUploadScope(decodeURIComponent(match[1]!))
  } catch {
    return null
  }
}

export function isTrainUploadsPath(path: string): boolean {
  return uploadScopeForPath(path) !== null
}
