import { join, relative, resolve, sep } from 'node:path'

import { isPathInside, type GatewayAnchor } from '@repo/contract'

import { resolveBound } from '../agents/agent-context'
import { agentUploadScope, ROOT_UPLOAD_SCOPE, type UploadScope } from '../auth/upload-scope'

export interface InheritedTrainDir {
  ownerScope: string
  memoriesDir: string
}

export interface TrainScope {
  key: string
  agentRoot: string
  memoriesDir: string
  inheritedDirs: InheritedTrainDir[]
  uploadsScope: UploadScope
  jobsDir: string
}

export class TrainScopeResolutionError extends Error {
  override readonly name = 'TrainScopeResolutionError'

  constructor(readonly code: 'invalid_anchor_id' | 'not_found') {
    super(code)
  }
}

export function trainScopeErrorResponse(error: unknown): Response {
  if (!(error instanceof TrainScopeResolutionError)) throw error
  return Response.json(
    { error: error.code },
    { status: error.code === 'invalid_anchor_id' ? 400 : 404 },
  )
}

export function resolveTrainScope(args: {
  anchorId?: string
  anchors: readonly GatewayAnchor[]
  driveDir: string
  stateDir: string
}): TrainScope {
  const jobsDir = join(args.stateDir, 'train', 'jobs')
  if (args.anchorId === undefined) {
    return {
      key: 'root',
      agentRoot: args.driveDir,
      memoriesDir: join(args.driveDir, '.agents', 'memories'),
      inheritedDirs: [],
      uploadsScope: ROOT_UPLOAD_SCOPE,
      jobsDir,
    }
  }

  let uploadsScope: UploadScope
  try {
    uploadsScope = agentUploadScope(args.anchorId)
  } catch {
    throw new TrainScopeResolutionError('invalid_anchor_id')
  }
  const anchor = args.anchors.find(
    candidate => candidate.id === args.anchorId && candidate.agentId !== undefined,
  )
  if (anchor === undefined) throw new TrainScopeResolutionError('not_found')

  const contextArgs = {
    cwd: anchor.path,
    driveDir: args.driveDir,
    stateDir: args.stateDir,
    defaultMemoryDbPath: join(args.stateDir, 'memory.db'),
    anchors: args.anchors,
  }
  let context: ReturnType<typeof resolveBound>
  try {
    context = resolveBound(contextArgs, anchor.id)
  } catch {
    throw new TrainScopeResolutionError('not_found')
  }

  const ancestorScopes = args.anchors
    .filter(candidate => candidate.id !== anchor.id && candidate.agentId !== undefined)
    .flatMap(candidate => {
      try {
        const ancestor = resolveBound(contextArgs, candidate.id)
        return [
          {
            ownerScope: candidate.id,
            agentRoot: ancestor.agentRoot,
            memoriesDir: join(ancestor.agentRoot, '.agents', 'memories'),
          },
        ]
      } catch {
        return []
      }
    })
    .sort(
      (left, right) =>
        pathDepth(right.agentRoot, args.driveDir) - pathDepth(left.agentRoot, args.driveDir),
    )
  // The inherited LIST names only stores that some Train page owns: each
  // ancestor agent's root store, then the drive root's. A hand-made
  // `.agents/memories` at an intermediate non-agent directory still injects
  // at session runtime (the CLI walk is broader by design), but listing it
  // here would attribute it to an owner whose Train page cannot show it —
  // a dead link the whole-spec review caught.
  const inheritedDirs: InheritedTrainDir[] = []
  const driveRoot = resolve(args.driveDir)
  const agentRootResolved = resolve(context.agentRoot)
  for (const ancestor of ancestorScopes) {
    const ancestorRoot = resolve(ancestor.agentRoot)
    if (ancestorRoot === agentRootResolved || !isPathInside(ancestorRoot, agentRootResolved)) {
      continue
    }
    inheritedDirs.push({
      ownerScope: ancestor.ownerScope,
      memoriesDir: join(ancestorRoot, '.agents', 'memories'),
    })
  }
  if (agentRootResolved !== driveRoot) {
    inheritedDirs.push({
      ownerScope: 'root',
      memoriesDir: join(driveRoot, '.agents', 'memories'),
    })
  }

  return {
    key: anchor.id,
    agentRoot: context.agentRoot,
    memoriesDir: join(context.agentRoot, '.agents', 'memories'),
    inheritedDirs,
    uploadsScope,
    jobsDir,
  }
}

function pathDepth(path: string, root: string): number {
  return relative(root, path).split(sep).filter(Boolean).length
}
