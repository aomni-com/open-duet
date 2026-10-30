# Syncthing disk-events probe — slice 18 builder-confirm (2026-07-13)

**Verdict: GREEN** — every slice-18 assumption held on a real VM, with one
translation-shaping surprise (no `added` action) folded into the code.

Harness: `packages/exe/scripts/probe-syncthing-events.ts` (probe-common;
VM tagged `duet-test`, deleted in `finally`, leak-check scoped to this run's
VMs; driven via the Shelley-bootstrapped HTTPS exec proxy — no account SSH
key on this machine). Two real Syncthing device instances (separate
homes/identities/DBs) shared a folder over loopback BEP on one exe.dev VM —
the same transport shape production uses, where peers dial
`tcp://192.0.2.1:<bridgePort>` through the sync tunnel. All admin/events API
calls stayed inside the VM on loopback (L14).

## Version verified (and the pin delta)

```
syncthing v1.27.2-ds4 "Gold Grasshopper" (go1.22.2 linux-amd64) debian
```

This is what `apt-get install syncthing` yields on the exeuntu base — i.e.
what the duet vm-image installs today (unpinned apt, research
[syncthing-operations.md](syncthing-operations.md) §A). **The spec's V1
decision wants a pinned official v2.1.x**; that swap is slice-19 vm-image
work. Flag for slice 19: re-run this probe against the pinned release when it
lands — the event *envelope* is stable, but v2 moved to the SQLite index and
the action vocabulary below is pinned only for v1.27.

## Event facts (all builder-confirmed)

- `GET /rest/events/disk?since=&timeout=` long-poll works as documented and
  is pre-filtered: only `LocalChangeDetected` / `RemoteChangeDetected`
  appeared across the whole run.
- Envelope: `{ id, globalID, time (RFC3339 ns), type, data }`; `id` is the
  **per-subscription sequence** — observed strictly consecutive
  (`1,2,3,4,5,6`) while `globalID` jumped (`16,28,39,49,59,66`). Gap
  detection by `id` discontinuity is sound (L15).
- A Syncthing restart **resets subscription ids** (after restarting instance
  B its next event had `id: 1` again) — a stale `since` cursor would stall
  forever. The consumer's error-path cursor re-init (`resets` counter)
  handles this; ids are never durable (L15).
- `data` shape: `{ action, folder, folderID, label, path, type, modifiedBy }`.
  `path` is **folder-relative** (`"file1.txt"`, never absolute) — translation
  joins it onto the mount's drive prefix.
- `modifiedBy` is the **short device ID** (7 chars, the first group of the
  full 63-char ID): `modifiedBy=XQ3MYTA`, writer
  `XQ3MYTA-TI4QLE6-…`. Slice 20's device→credential binding must resolve
  short IDs (or prefix-match the full ID it stores).
- **`action` knows only `modified` and `deleted`.** New files, new dirs, and
  new symlinks all arrive as `action: "modified"` — there is no `added`
  action in v1.27 (matches source: the disk-event emitter defaults to
  `modified` and switches only on `IsDeleted()`). Renames therefore land as
  a `deleted` + `modified` pair. Translation maps modified→`write`,
  deleted→`delete`; `added`→`create` is kept defensively should a future pin
  grow the vocabulary.
- `data.type` distinguishes `file` / `dir` / `symlink`. Symlinks fire like
  files; dirs fire too (translated as activity-only — no DriveFileEvent,
  matching the API path where mkdir emits nothing).
- `RemoteChangeDetected` fires per applied remote item **on `receiveonly`
  folders as well as `sendreceive`** — both duet folder modes (`read`/`write`)
  are covered.
- `POST /rest/db/scan?folder=&sub=` is synchronous and cheap for targeted
  subs (1 ms for a one-file sub on an idle folder).

## Scan-nudge latency vs. watcher baseline

Writer instance had `fsWatcherEnabled=false`, `rescanIntervalS=3600` for the
nudge runs — only the nudge could move data. Latency = wall time from the
write/scan trigger until the peer's `RemoteChangeDetected` was observable
over `/rest/events/disk`:

| Path | Latency |
|---|---|
| nudge, new file | 9 ms |
| nudge, modified file | 249 ms |
| nudge, deleted file | 242 ms |
| nudge, receiveonly peer | 10 ms |
| watcher baseline (`fsWatcherDelayS=1`, no nudge) | 1008 ms |

The nudge path is sub-second with large headroom (the ~240 ms cases include
Syncthing's internal pull scheduling); the watcher baseline is dominated by
the 1 s debounce, exactly as designed — the nudge buys ~4–100× on top of a
correctness baseline that already works. A dead nudge degrades latency only.

## What this pins for the code

- `syncthing-events.ts`: modified→write/deleted→delete mapping;
  folder-relative path join; short-ID `modifiedBy` through the
  device-resolution seam; per-subscription gap counting; cursor re-init on
  poll failure (restart-safe).
- `scan-nudge.ts`: repeatable `sub=` targeted scans are cheap and safe to
  batch; whole-folder collapse stays the fallback.
- Slice 19: pin swap (v2.1.x) requires a probe re-run; keep
  `fsWatcherDelayS=1` as the correctness baseline for mirror folders.
