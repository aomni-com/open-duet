/**
 * Formats a Syncthing-style conflict path without touching the filesystem.
 * Callers that probe for collisions own that loop and pass its counter here.
 * Pure string manipulation — this module must load in the Convex isolate,
 * so `node:path` is off limits.
 */
export function formatSyncConflictName(
  path: string,
  at: Date,
  device: string,
  collision?: number,
): string {
  if (collision !== undefined && (!Number.isInteger(collision) || collision < 0)) {
    throw new RangeError('Conflict collision must be a non-negative integer')
  }
  const slash = path.lastIndexOf('/')
  const directory = path.slice(0, slash + 1)
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot) : ''
  const stem = dot > 0 ? base.slice(0, dot) : base
  const digits = at.toISOString().replace(/[-:T]/g, '')
  const timestamp = `${digits.slice(0, 8)}-${digits.slice(8, 14)}`
  const safeDevice = device.replace(/[^A-Za-z0-9]/g, '').slice(0, 7) || 'CREATOR'
  const collisionMarker = collision === undefined || collision === 0 ? '' : `-${collision}`
  return `${directory}${stem}.sync-conflict-${timestamp}-${safeDevice}${collisionMarker}${extension}`
}
