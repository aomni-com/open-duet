# Syncthing v2.1.2 pin — event-shape re-run (slice 19)

Slice 19 swaps the vm-image's unpinned apt Syncthing (v1.27.2-ds4, the version
slice 18's probe verified against) for a SHA-pinned official release. MAP-SYNC
V1 and slice 18's Result both flag: **re-run the slice-18 event-shape checks
against the new pin.** This is that record.

## Pin chosen

- **Syncthing v2.1.2** "Hafnium Hornet" (released 2026-06-08; latest stable
  v2.x at slice time), the newest v2.1.x line per MAP-SYNC V1.
- `syncthing-linux-amd64-v2.1.2.tar.gz` sha256
  `0cea24660ac7d8df19f01da979827b5c9463a8a60042e296829293cf80213ee4`
  (vm-image is `linux/amd64`). arm64 (Mac bundle, slice 22):
  `2fcee9688f37df46337b0b78e7d2badc44549481e29eccaa8cdb1e698d79c8c5`.
- Pinned in `packages/vm-image/Dockerfile` (`ARG SYNCTHING_VERSION`/
  `SYNCTHING_SHA256`), asserted by `scripts/verify-image.ts`
  (`EXPECTED_SYNCTHING_VERSION`).

## Method

Two real Syncthing **v2.1.2** instances, separate homes/identities/DBs, share a
`sendreceive` folder over loopback BEP (the production transport shape) — the
same two-instance shape slice 18 used, re-run locally against the pinned binary
(SHA-verified download). Configured via `PUT /rest/config` (the gateway's
`updateSyncthingConfig` mechanism), then a write on A + `POST /rest/db/scan`,
polling B's `/rest/events/disk`. Verdict: **GREEN** — every slice-18 load-bearing
fact holds on v2.1.2.

## Findings (verbatim probe output)

```json
{
  "pin": "syncthing v2.1.2 \"Hafnium Hornet\" (go1.26.5 darwin-arm64)",
  "peerConnected": true,
  "scanSynchronousMs": 14,
  "remoteChangeSeen": true,
  "eventShape": { "id": "number", "type": "RemoteChangeDetected",
    "dataKeys": ["action","folder","folderID","label","modifiedBy","path","type"] },
  "data": { "folder": "probe-share", "path": "notes.md", "action": "modified",
    "type": "file", "modifiedBy": "NMWD7HN", "modifiedByLen": 7,
    "modifiedByIsShort": true, "modifiedByMatchesAShortId": true }
}
```

- `/rest/events/disk` long-poll shape unchanged: numeric `id`, `type`, `data`.
- `RemoteChangeDetected` fires per applied remote item with `modifiedBy` — and
  `modifiedBy` is the **SHORT 7-char device ID** (`NMWD7HN`), matching the
  writer's short ID exactly. This confirms slice 18's finding on the new pin and
  validates the slice-19 seam: `mirrorCredentialForShortDeviceId` /
  `syncthingShortDeviceId` resolve `modifiedBy` → the credential doc id.
- `data.path` is folder-relative; `action` is `modified` (→ `write`); `type` is
  `file` — the translator's `ACTION_TO_KIND` + dir/file handling is unchanged.
- `POST /rest/db/scan` is synchronous (~14 ms), as slice 18 relied on.

**Additive-only delta on v2.1.2:** `data` now also carries `folderID` and
`label` alongside `folder`. The translator reads `data.folder` (still present),
so no code change is required — noted so a future pin bump knows the field set
grew, not shrank.

## Reproduce

`scratchpad/probe-v2.ts` in the slice-19 session (self-contained Bun script;
downloads the SHA-verified macOS arm64 binary and runs both instances on
loopback). Not committed to `packages/exe/scripts` — it is a local re-run of the
committed `probe-syncthing-events.ts` against the new pin, not a new harness.

## L16 (Syncthing db/identity survives archive→restore) — architectural verdict

Verified by construction, not re-probed on a VM this slice (the mechanism is
unchanged from what slice-15/18 already exercise on real VMs):

1. **Home inside the archived stateDir.** `duet-syncthing.service`
   `--home=/home/synthetic-user/.duet/syncthing`; stateDir is `/home/synthetic-user/.duet`
   (`DUET_STATE_DIR_PATH`). `tarWorkspaceState` archives `basename(stateDir)`
   (`.duet`, which contains `syncthing/` — identity keys + `index-v2` SQLite db).
   A restored VM therefore presents the **same** device ID with a warm index —
   no new-device / full-reindex / conflict storm.
2. **Restore-stop = zero deletion broadcasts (V3/L18).** `restoreArchive` stops
   `duet-syncthing.service` around the `rm -rf`/rename swap and restarts it in
   `finally` — asserted in `gateway.test.ts` (`restoreExecCalls` =
   stop→start). Syncthing is down during the half-empty-tree window, so it can
   never broadcast that window as deletions to connected mirrors. This also
   closes slice 15's deferred deletion-broadcast assertion.

**Remaining builder-confirm (real VM), deferred with a runbook:** the full
register → connect → sync a fixture both ways → retire → restore → resume
round-trip on a live exe.dev VM with the slice-19 image. It exercises no new
retire/restore machinery (only that slice-15 flow, already VM-verified, plus a
registered mirror device); the risk it would catch is an interaction between a
connected mirror and the restore swap, which the restore-stop is designed to
neutralize. Run against a VM built from the slice-19 vm-image once an image bake
is scheduled (the pin + hardening land in the next image rebuild, per MAP-SYNC
"next image rebuild is the fleet story").
