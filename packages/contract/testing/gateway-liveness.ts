import type { GatewayAnchor } from '../src'
import type { DriveFileEvent, FileEventBatch } from '../src/file-attribution'

const ACTOR = 'session:risk-harness'

type EventInput = DriveFileEvent extends infer Event
  ? Event extends { actor: string; at: number }
    ? Omit<Event, 'actor' | 'at'> & Partial<Pick<Event, 'actor' | 'at'>>
    : never
  : never

export function event(value: EventInput): DriveFileEvent {
  return { actor: ACTOR, at: 1, ...value } as DriveFileEvent
}

export function gatewayLivenessWorkload(noisyMutations = 2_000): DriveFileEvent[] {
  const deepPath = `${Array.from({ length: 96 }, (_, index) => `level-${index}`).join('/')}/leaf.md`
  return [
    event({ kind: 'write', path: 'README.md' }),
    event({ kind: 'read', path: 'README.md' }),
    ...Array.from({ length: noisyMutations }, (_, index) =>
      event({
        kind: index % 7 === 0 ? 'read' : 'write',
        path: `node_modules/pkg-${index}/index.js`,
      }),
    ),
    event({ kind: 'write', path: '.git/objects/aa/object' }),
    event({ kind: 'write', path: deepPath }),
    event({ kind: 'rename', entryKind: 'file', fromPath: 'docs/draft.md', path: 'docs/final.md' }),
    event({
      kind: 'rename',
      entryKind: 'file',
      fromPath: 'node_modules/a/index.js',
      path: 'src/vendor-a.js',
    }),
    event({ kind: 'restore' }),
  ]
}

export interface GatewayLivenessAnchorWorkload {
  anchors: GatewayAnchor[]
  generatedEntryCount: number
  generatedPathAt(index: number): string
  evidenceCases: readonly ['restore_in_flight', 'drive_unreadable', 'genuine_absence']
  reconcileCallers: readonly ['sync', 'sync', 'api', 'api']
}

export function gatewayLivenessAnchorWorkload(
  generatedEntryCount = 1_828_400,
): GatewayLivenessAnchorWorkload {
  return {
    anchors: [
      {
        id: 'anchor-risk-harness',
        workspaceId: 'workspace-risk-harness',
        path: 'agents/researcher',
        kind: 'agent',
        settings: {},
        state: 'active',
        markerNonce: 'risk-harness-nonce',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    generatedEntryCount,
    generatedPathAt: index => `node_modules/pkg-${index}/nested/index.js`,
    evidenceCases: ['restore_in_flight', 'drive_unreadable', 'genuine_absence'],
    reconcileCallers: ['sync', 'sync', 'api', 'api'],
  }
}

export function sealedBatch(
  events: DriveFileEvent[],
  batchId = 'gateway-liveness-1',
): FileEventBatch {
  return { batchId, events: structuredClone(events), droppedReads: 0, overflow: 0 }
}

export interface LogicalEntryScenario {
  name: string
  events: DriveFileEvent[]
  selectedPath: string
  inheritedEventIndexes: number[]
  namespaceMutationCeiling: number
}

export const LOGICAL_ENTRY_MATRIX: readonly LogicalEntryScenario[] = [
  {
    name: 'file rename chain',
    events: [
      event({ kind: 'write', path: 'a' }),
      event({ kind: 'rename', entryKind: 'file', fromPath: 'a', path: 'b' }),
      event({ kind: 'rename', entryKind: 'file', fromPath: 'b', path: 'c' }),
    ],
    selectedPath: 'c',
    inheritedEventIndexes: [0, 1, 2],
    namespaceMutationCeiling: 2,
  },
  {
    name: 'folder move retains descendant history',
    events: [
      event({ kind: 'write', path: 'old/child/note.md' }),
      event({ kind: 'rename', entryKind: 'folder', fromPath: 'old', path: 'new' }),
    ],
    selectedPath: 'new/child/note.md',
    inheritedEventIndexes: [0],
    namespaceMutationCeiling: 2,
  },
  {
    name: 'path reuse shadows an alias',
    events: [
      event({ kind: 'write', path: 'a' }),
      event({ kind: 'rename', entryKind: 'file', fromPath: 'a', path: 'b' }),
      event({ kind: 'create', entryKind: 'file', path: 'a' }),
    ],
    selectedPath: 'a',
    inheritedEventIndexes: [2],
    namespaceMutationCeiling: 2,
  },
  {
    name: 'rename-over keeps source identity',
    events: [
      event({ kind: 'write', path: 'source' }),
      event({ kind: 'write', path: 'destination' }),
      event({ kind: 'rename', entryKind: 'file', fromPath: 'source', path: 'destination' }),
    ],
    selectedPath: 'destination',
    inheritedEventIndexes: [0, 2],
    namespaceMutationCeiling: 3,
  },
  {
    name: 'copy does not inherit',
    events: [
      event({ kind: 'write', path: 'source' }),
      event({ kind: 'create', entryKind: 'file', path: 'copy' }),
    ],
    selectedPath: 'copy',
    inheritedEventIndexes: [1],
    namespaceMutationCeiling: 1,
  },
  {
    name: 'delete then create does not inherit',
    events: [
      event({ kind: 'write', path: 'a' }),
      event({ kind: 'delete', entryKind: 'file', path: 'a' }),
      event({ kind: 'create', entryKind: 'file', path: 'a' }),
    ],
    selectedPath: 'a',
    inheritedEventIndexes: [2],
    namespaceMutationCeiling: 2,
  },
  {
    name: 'hard link is a separate entry',
    events: [
      event({ kind: 'write', path: 'original' }),
      event({ kind: 'create', entryKind: 'file', path: 'hard-link' }),
    ],
    selectedPath: 'hard-link',
    inheritedEventIndexes: [1],
    namespaceMutationCeiling: 1,
  },
  {
    name: 'restore starts a new epoch',
    events: [
      event({ kind: 'write', path: 'a' }),
      event({ kind: 'restore' }),
      event({ kind: 'create', entryKind: 'file', path: 'a' }),
    ],
    selectedPath: 'a',
    inheritedEventIndexes: [2],
    namespaceMutationCeiling: 2,
  },
] as const

export const SAME_BATCH_ORDER_CASES = [
  ['rename', 'write'],
  ['write', 'rename'],
  ['delete', 'create'],
  ['create', 'delete'],
] as const

export const ATOMIC_EDITOR_REPLACEMENT = [
  event({ kind: 'rename', entryKind: 'file', fromPath: '.note.md.tmp', path: 'note.md' }),
  event({ kind: 'write', path: 'note.md' }),
] as const

export const EXPLICIT_FILES_MOVE = [
  event({ kind: 'rename', entryKind: 'file', fromPath: 'draft.md', path: 'note.md' }),
] as const
