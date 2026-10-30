import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { canonicalAgentCwd, type GatewayAnchor } from '@repo/contract'

export type SpawnCwdFallbackReason =
  | 'missing'
  | 'not_a_directory'
  | 'outside_drive'
  | 'outside_agent_anchor'

export interface SpawnCwdResolution {
  cwd?: string
  terminal?: true
  fallback?: {
    from: string
    to: string
    reason: SpawnCwdFallbackReason
  }
}

export function resolveSpawnCwd(args: {
  driveDir: string
  requestedCwd?: string
  anchors: readonly GatewayAnchor[]
  agentAnchorId?: string
}): SpawnCwdResolution {
  const anchor =
    args.agentAnchorId === undefined
      ? undefined
      : args.anchors.find(candidate => candidate.id === args.agentAnchorId)
  if (args.agentAnchorId !== undefined && anchor === undefined) {
    return terminal()
  }

  const root = resolve(args.driveDir)
  let realAnchorRoot: string | undefined
  if (anchor !== undefined) {
    const anchorRoot = resolve(root, anchor.path)
    if (!isContained(root, anchorRoot)) return terminal()
    try {
      const realRoot = realpathSync(root)
      realAnchorRoot = realpathSync(anchorRoot)
      if (!isContained(realRoot, realAnchorRoot) || !statSync(realAnchorRoot).isDirectory()) {
        return terminal()
      }
    } catch {
      return terminal()
    }
  }

  const requestedCwd = args.requestedCwd
  if (
    anchor === undefined &&
    (requestedCwd === undefined || requestedCwd.length === 0 || requestedCwd === '/')
  ) {
    return {}
  }
  const resolved =
    requestedCwd === undefined || requestedCwd.length === 0 || requestedCwd === '/'
      ? root
      : resolve(root, requestedCwd)
  if (
    (requestedCwd !== undefined && requestedCwd !== '/' && isAbsolute(requestedCwd)) ||
    !isContained(root, resolved)
  ) {
    return fallback(anchor, requestedCwd, 'outside_drive')
  }

  let realRoot: string
  let realRequested: string
  try {
    realRoot = realpathSync(root)
    realRequested = realpathSync(resolved)
  } catch {
    return fallback(anchor, requestedCwd, 'missing')
  }
  if (!isContained(realRoot, realRequested)) {
    return fallback(anchor, requestedCwd, 'outside_drive')
  }
  if (!statSync(realRequested).isDirectory()) {
    return fallback(anchor, requestedCwd, 'not_a_directory')
  }
  if (anchor !== undefined) {
    if (!isContained(realAnchorRoot!, realRequested)) {
      return fallback(anchor, requestedCwd, 'outside_agent_anchor')
    }
  }

  const relativeCwd = relative(root, resolved).split(sep).join('/')
  const cwd = relativeCwd === '' ? undefined : canonicalAgentCwd(relativeCwd)
  return cwd === undefined ? {} : { cwd }
}

function terminal(): SpawnCwdResolution {
  return { terminal: true }
}

function fallback(
  anchor: GatewayAnchor | undefined,
  requestedCwd: string | undefined,
  reason: SpawnCwdFallbackReason,
): SpawnCwdResolution {
  const cwd = anchor === undefined ? undefined : canonicalAgentCwd(anchor.path)
  const from = requestedCwd === undefined || requestedCwd.length === 0 ? '/' : requestedCwd
  const to = cwd ?? '/'
  return {
    ...(cwd === undefined ? {} : { cwd }),
    fallback: { from, to, reason },
  }
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}
