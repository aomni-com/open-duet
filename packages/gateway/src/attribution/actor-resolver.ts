/**
 * The ONE place a kernel filesystem event (a helper `fs` frame) becomes an
 * attributed `DriveFileEvent` — OS-event → actor policy, MAP Q1/Q3/Q10 and the
 * slice-11 contract. Pure and synchronous: no I/O, no process state; the
 * gateway wires it between the helper supervisor (slice 10) and the one file
 * pipeline (slice 04).
 *
 * Policy (the whole of it — every branch is probe- or firewall-pinned):
 * - `unit` is a canonical session cgroup leaf → `session:<id>`. The helper
 *   emits the raw leaf; `sessionForCgroupLeaf` is the shared validator, so a
 *   non-session leaf is never mistaken for a session.
 * - `unit` is null or a non-session leaf → a **write/create/delete/rename** is
 *   audited as `terminal` (SSH / non-agent exec), a **read** is dropped (Q1:
 *   unattributed reads carry no signal). This is also where the slice-09
 *   open-less `rm`/`mv` boundary lands: a bare delete/rename whose pid escaped
 *   the perm-pin arrives `unit: null` and is deterministically labelled
 *   `terminal` — the audit actor degrades to coarse, the path is never wrong
 *   (research/helper-probe.md §1/§5; policy recorded in slice 11's Result).
 *
 * NOT here (firewall — "semantic events win", README):
 * - Sync attribution. A remote share/mirror write reaches the drive through the
 *   Syncthing process, whose pid is dropped IN-HELPER exactly like gateway-pid;
 *   slice 18 (`syncthing-events.ts`) attributes it `sync:<shareId>` /
 *   `mirror:<deviceId>` from `RemoteChangeDetected.modifiedBy`. The resolver is
 *   therefore path-agnostic: a session's own edit inside a shared folder stays
 *   `session:<id>` and is never re-labelled by path prefix, so no drive write is
 *   ever counted twice. (This retired MAP Q10's path-prefix `sync:` selection —
 *   MAP-SYNC amendment log; see slice 11's Result for the recorded decision.)
 * - The `system` fallback for a null-actor write. The resolver never produces a
 *   null actor, so that fallback lives only in the pipeline for non-watcher
 *   paths; restore emits its own single `system` event (slice-11 suppression).
 */
import { encodeActorContext, type DriveFileEvent } from '@repo/contract'

import { sessionForCgroupLeaf } from '../runner/cgroup'
import type { HelperFsEvent } from './helper-protocol'

export interface ActorResolverOptions {
  /**
   * The gateway's own pid. Gateway-pid events are dropped in-helper (L9); this
   * is a defensive second drop so the resolver — the single policy owner — never
   * lets a gateway self-write through even if the helper's drop set drifts.
   */
  gatewayPid?: number
}

export interface ActorResolver {
  /** Maps one helper `fs` frame to an attributed event, or null when dropped. */
  resolve(event: HelperFsEvent): DriveFileEvent | null
}

export function createActorResolver(options: ActorResolverOptions = {}): ActorResolver {
  const gatewayPid = options.gatewayPid

  return {
    resolve(event: HelperFsEvent): DriveFileEvent | null {
      if (gatewayPid !== undefined && event.pid === gatewayPid) return null

      const sessionId = event.unit === null ? null : sessionForCgroupLeaf(event.unit)
      if (sessionId !== null) {
        return toDriveEvent(event, encodeActorContext({ kind: 'session', sessionId }))
      }

      // Unattributed or non-session unit: reads carry no signal (Q1), the rest
      // are terminal audit rows (includes the null-unit rm/mv boundary).
      if (event.kind === 'read') return null
      return toDriveEvent(event, encodeActorContext({ kind: 'terminal' }))
    },
  }
}

function toDriveEvent(event: HelperFsEvent, actor: string): DriveFileEvent {
  const at = Number.isFinite(event.at) ? Math.max(0, Math.floor(event.at)) : 0
  const base = { actor, at }
  switch (event.kind) {
    case 'read':
      return { kind: 'read', path: event.path, ...base }
    case 'write':
      return { kind: 'write', path: event.path, ...base }
    case 'create':
      return { kind: 'create', entryKind: event.entryKind, path: event.path, ...base }
    case 'delete':
      return { kind: 'delete', entryKind: event.entryKind, path: event.path, ...base }
    case 'rename':
      // A rename whose source is outside the drive has no in-drive fromPath (a
      // MOVED_TO with no join partner): honestly a new file appearing → create.
      return event.fromPath === undefined
        ? { kind: 'create', entryKind: event.entryKind, path: event.path, ...base }
        : {
            kind: 'rename',
            entryKind: event.entryKind,
            path: event.path,
            fromPath: event.fromPath,
            ...base,
          }
  }
}
