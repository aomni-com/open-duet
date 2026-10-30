import { z } from 'zod'

import {
  COLLECTION_PAGE_MAX_LIMIT,
  CollectionPageQuerySchema,
  collectionPageSchema,
} from '../pagination/index'
import { VCS_AND_DEPS_IGNORE, WHOLE_DRIVE_IGNORE } from '../sync-ignore/index'

// Mirror-device orchestration vocabulary (spec file-attribution slice 19).
// A mirror is a whole-drive, bidirectional replica of one workspace held by a
// registered sync machine. This module owns the wire shapes the
// public routes speak and the operational constants the gateway provisions —
// never the Syncthing admin API, which stays loopback (MAP-SYNC L14).

// The single whole-drive mirror folder id on every workspace VM. One folder,
// rooted at the drive, shared with every registered mirror device (star
// topology — devices know only the VM).
export const MIRROR_FOLDER_ID = 'workspace-drive'

// The gateway owns the complete registry. One maximum public page bounds its
// source work while the public cursor endpoint remains the collection contract.
export const MAX_MIRROR_DEVICES_PER_WORKSPACE = COLLECTION_PAGE_MAX_LIMIT
export const MAX_SYNC_MACHINES_PER_USER = 100

// The mirror `.stignore` (MAP-SYNC G1 + Q7): the whole-drive folder is rooted
// at the drive, so it excludes both the drive-root-only group (`.duet`,
// Syncthing internals — which a subtree share never contains) and the shared
// git/deps verdict. Both groups, and the reason `.env` is absent, live in
// `../sync-ignore` — the one home shared with the share default.
export const DEFAULT_MIRROR_IGNORE_PATTERNS = [
  ...WHOLE_DRIVE_IGNORE,
  ...VCS_AND_DEPS_IGNORE,
] as const

// Mirror folder knobs (MAP-SYNC K3/K5/K6/K7). `fsWatcherDelayS` must stay > 0:
// a value <= 0 silently DISABLES the watcher (L22), so the value is pinned and
// asserted, never merely defaulted. `ignorePerms=false` keeps the exec bit
// (K5 correction — `true` strips it and floods git with mode-change noise).
// `caseSensitiveFS` / `modTimeWindowS` keep Syncthing's cross-platform-safe
// defaults. `maxConflicts=10` is explicit (the docs self-contradict on the
// default).
const MIRROR_FOLDER_TYPE = 'sendreceive' as const
const MIRROR_FS_WATCHER_DELAY_S = 1
const MIRROR_IGNORE_PERMS = false
const MIRROR_MAX_CONFLICTS = 10

interface MirrorFolderKnobs {
  type: typeof MIRROR_FOLDER_TYPE
  fsWatcherEnabled: true
  fsWatcherDelayS: number
  ignorePerms: boolean
  maxConflicts: number
}

export const MIRROR_FOLDER_KNOBS: MirrorFolderKnobs = {
  type: MIRROR_FOLDER_TYPE,
  fsWatcherEnabled: true,
  fsWatcherDelayS: MIRROR_FS_WATCHER_DELAY_S,
  ignorePerms: MIRROR_IGNORE_PERMS,
  maxConflicts: MIRROR_MAX_CONFLICTS,
}

// A Syncthing device ID is base32 groups (uppercase A–Z, 2–7) joined by
// dashes; the short ID Syncthing puts on the wire (RemoteChangeDetected
// `modifiedBy`) is its first 7 characters. Validation is deliberately loose —
// the exact length carries a Luhn check we do not re-verify here — but rejects
// anything that could not be a device id.
const SYNCTHING_DEVICE_ID_PATTERN = /^[A-Z2-7]{7}(-[A-Z2-7]{7})*$/

// A plain regex (no transform) so the schema renders as JSON Schema for the
// endpoint reference. Device IDs are canonically uppercase; a client sends the
// value exactly as Syncthing displays it.
export const SyncthingDeviceIdSchema = z
  .string()
  .regex(SYNCTHING_DEVICE_ID_PATTERN, 'Invalid Syncthing device ID')

/** The 7-char short ID Syncthing reports on the wire — the first group. */
export function syncthingShortDeviceId(deviceId: string): string {
  return deviceId.replace(/-/g, '').slice(0, 7).toUpperCase()
}

export const MirrorRegisterRequestSchema = z.object({
  machineId: z.string().min(1),
  syncthingDeviceId: SyncthingDeviceIdSchema,
})

const MirrorTunnelGrantSchema = z.object({
  url: z.string(),
  tunnelToken: z.string(),
  expiresAt: z.number(),
})
export type MirrorTunnelGrant = z.infer<typeof MirrorTunnelGrantSchema>

export const MirrorRegisteredSchema = z.object({
  machineId: z.string().min(1),
  folderId: z.string(),
  vmSyncthingDeviceId: z.string(),
  tunnel: MirrorTunnelGrantSchema,
})
export type MirrorRegistered = z.infer<typeof MirrorRegisteredSchema>

const MirrorDeviceSchema = z.object({
  // Non-secret machine identity, independent of the authenticating key.
  machineId: z.string(),
  deviceName: z.string().optional(),
  syncthingDeviceId: z.string(),
  registeredAt: z.number(),
})
export type MirrorDevice = z.infer<typeof MirrorDeviceSchema>

export const MirrorDeviceListQuerySchema = CollectionPageQuerySchema
export const MirrorDeviceListSchema = collectionPageSchema(MirrorDeviceSchema)

export const MirrorRemovedSchema = z.object({
  ok: z.literal(true),
  machineId: z.string(),
})
