# Drive sync — exploration map

Product goal: a Mac CLI/daemon (`duetfs sync`) that mirrors every workspace
drive to a local folder, Dropbox-style — real-time down, safe writes up,
mostly-mirror but strict-workbench capable. Produced by a quadrant walk
(2026-07-10 → 2026-07-13); feeds a future write-spec session. First client is
macOS; the protocol decisions are client-agnostic.

This map extends [MAP.md](MAP.md) — the attribution walk whose event pipeline
drive sync rides; both maps bind the one spec in this folder. Related but
separate: [specs/write-containment/](../../write-containment/README.md) (shared
research, different surface).

## 1 · Known knowns — settled ground

- Drive files are plain POSIX files on the workspace VM at `/home/synthetic-user/drive`
  (`packages/contract/src/drive/index.ts:1`); Convex holds metadata + a tar
  archive of retired drives (`packages/gateway/src/vm/archive.ts`,
  `domains/workspaces/provisioningActions.ts`). Live bytes = VM disk.
- Public REST surface (`service.example.invalid/v1/ws/{slug}/files...`): single-level list,
  stat, streamed GET (Range, stat-based ETag), atomic PUT (temp+rename+fsync,
  If-Match→412), delete, mkdir/move/copy actions
  (`packages/gateway/src/routes/files.ts`, registry
  `packages/contract/src/endpoints/index.ts:462-527`). No recursive list, no
  content hashes, no change feed, no resumable upload.
- ETag = `dev-ino-size-mtimeNs-ctimeNs` — strong but inode-bound; every VM
  archive→restore rewrites inodes and invalidates all ETags.
- **VMs never sleep.** exe.dev micro-VMs run continuously; the only lifecycle
  event is a 7-day-idle GC (`retire idle workspaces` cron,
  `DEFAULT_IDLE_RETIRE_MS = 7d`, `provisioningCore.ts:9`) which archives the
  drive and marks the workspace `retired`. Retired workspaces 404 through the
  files proxy; un-retire is internal-admin `unarchive` only.
- Auth: `duet_sk_` bearer keys, strictly single-workspace
  (`assertSingleWorkspaceScopes`, `apps/api/src/routes/device.ts:44`), device
  flow exists (`duetfs login`). `duetfs` is an npm package whose `ApiClient`,
  `~/.duet/config.json`, and auth commands are directly reusable.
- The file-attribution spec (12 slices, not started) owns the one drive-event
  pipeline: fanotify FID/name helper (spike all-green on kernel 6.12.93) →
  gateway `attribution/pipeline.ts` (~5s/500-entry flush, batchId dedupe,
  in-memory, loss counted) → Convex `fileEvents` with durable per-workspace
  `seq` → slice-06 REST query surface. Firewall: **no parallel event recorder
  or sequence allocator may exist** — drive sync consumes this pipeline.
- Restore is one `system`/`restore` event, never a per-file storm
  (file-attribution L6) — the sync client's "run a manifest diff" trigger.
- `apps/api` deploys as a Vercel Node function: response streaming yes,
  WebSocket upgrade no. Agent-session SSE already streams through it with
  resumable `Last-Event-ID` (`apps/api/src/routes/agent.ts`,
  `packages/gateway/src/routes/agentSessions.ts`).

## 2 · Known unknowns — decision ledger

| # | Question | Decision | Closed by |
|---|----------|----------|-----------|
| Q1 | Realtime transport | Dedicated **SSE route** (`GET /v1/ws/:slug/file-activity/events`), first-class documented API, cursor via `Last-Event-ID`/`?cursor=`; comment-ping keepalive. WS ruled out (Vercel Node function, no upgrade support — the same gap that blocked edge sync-tunnel) | Example User + territory |
| Q2 | Change detection | Ride the file-attribution pipeline: fanotify helper → gateway pipeline → Convex `fileEvents` (durable seq survives VM re-provision). No sync-owned watcher | Territory (firewall) + Example User |
| Q3 | VM lifecycle | Sleep-transparent: the feed must never tick `lastActivityAt` (pin with a test). `retired` surfaces in daemon status; local edits queue. Auto-un-retire deferred: future = paid users never retire | Example User |
| Q4 | Auth for all workspaces | Relax the key model: new user-wide key kind, capability-limited to `files:*` + feed; **per-device credentials** so multi-Mac echo suppression works. `SECURITY.md` update owed | Example User |
| Q5 | Catch-up primitive | New gateway **manifest endpoint**: streamed NDJSON `{path, type, size, mtime, hash, target?}`; BLAKE3 hashes lazily computed, cached by `(ino, mtimeNs, size)` — hash survives restore | Example User |
| Q6 | Conflict policy | If-Match uploads; on 412 keep server version, preserve local as `name (conflicted copy from <device> <date>)`. Never lose bytes, never block | Example User |
| Q7 | Sync scope | True mirror downward (everything incl. `.git`, `node_modules`); `.duet` reserved; macOS junk (`.DS_Store`, `._*`, Spotlight/Trashes) excluded daemon-side on upload | Example User |
| Q8 | Deliverable | Extend `duetfs`: `duetfs sync` + `sync install` (launchd LaunchAgent), npm distribution, **versioned releases**. Personal tool first, but: web-app surface for sync keys/devices ships, and docs stay aligned with every API change | Example User |
| Q9 | Latency | ~5s pipeline flush accepted as real-time enough | Example User |
| Q10 | Seen-by pollution | **Mirror-exempt actor** (`mirror:<deviceId>`): daemon reads emit no read markers. Amends file-attribution MAP Q7/Q8 (uniform-actors rule gets one carve-out); touches slices 01 + 04 | Example User |
| Q11 | Event payload | Add optional `size`/`mtime` to write/create events — **raise before file-attribution slice 01 lands** (cheap now, migration later) | Example User |
| Q12 | Bulk clone | New gateway **tar-stream endpoint** (subtree-scoped, resumable by walking subtrees, links representable). Clone = manifest → parallel subtree tars → hash-verify. Pairs with the `VC_MAX_DURATION` and auth-overhead fixes (L3/L5) | Example User |
| Q13 | Symlinks | First-class: contract `type:'symlink'` + `target`, lstat-based listing/stat/manifest, link create in routes, `O_NOFOLLOW` PUT finals, archive policy aligned — a coordinated sub-spec (see L1) | Example User |
| Q14 | Hardlinks | **Content copies with hash dedupe** (the Dropbox/iCloud/Syncthing answer): two paths, one hash — transfer layer dedupes by hash; no inode-group fidelity promised. Optional link-group manifest hint later | Example User (delegated) |
| Q15 | Multi-Mac | Supported: per-device identity (Q4/Q10), independent daemons, conflict copies arbitrate | Example User |
| Q16 | Retention × cursors | Non-issue for now (no pruning exists; retention is a future spec). When it lands: pruning must yield a detectable "cursor too old" → manifest reconcile | Example User (deferred) |

Sequencing fact: slice 04 of file-attribution attributes only API-path writes;
**agent edits — the main thing the Mac wants to see — enter the feed at slice
11** (kernel watcher). Drive sync v1 is downstream of most of that ladder.

## 3 · Unknown knowns — extracted context

- **Personal tool first**, productize after it survives real use — but three
  product invariants hold from day one: web surface for the new key/device
  kind, docs aligned with the API at all times, versioned `duetfs` releases.
- **Mostly mirror, strict-workbench requirements**: dev workflows with git and
  `node_modules` must just work — which is what forced Q13/Q14 (links) and the
  upload-side reality that a local `bun install` uploads its tree (accepted
  under true mirror; hash dedupe blunts the wire cost).
- **Scale envelope: 25GB default → 100GB per workspace** (product intent; code
  currently caps VM disk at 10GB — `WORKSPACE_VM_CAPS.disk`,
  `packages/contract/src/resources/index.ts` — reconcile when quotas ship).
  First clone and full-manifest hashing are jobs, not requests: parallel,
  resumable, lazy; daemon checks local free space before committing.
- **"Feels like a real API"** matters: the SSE feed is a documented public
  route, not an internal hack.
- Echo suppression is identity-based: the daemon skips feed events whose actor
  is its own device credential.

## 4 · Unknown unknowns — landmine cards

| # | Landmine | Evidence | Status |
|---|----------|----------|--------|
| L1 | Symlinks are a stack-wide wall: contract can't represent them; listings `stat()` (not `lstat`) and **silently drop dangling/escaping links** (phantom deletions for a mirror); PUT clobbers a link in place; move/copy/recursive-delete 409 on any link in tree | `files.ts:284-307,363-364,507-508,485-486`; `contract/src/files/index.ts:6-12` | Decided (Q13 sub-spec) |
| L2 | **Latent product bug beyond this feature:** archive create emits symlink/hardlink tar entries but the restore validator rejects typeflags `1`/`2` — any workspace containing a link cannot be restored after retirement. Every dev workspace hits this | `archive.ts:30-42` vs `assertSafeTarEntries` `archive.ts:191-200` | **Escalated** — fix independent of sync |
| L3 | `apps/api` sets no `maxDuration` (siblings use `VC_MAX_DURATION=800`); platform default decapitates long SSE segments and any large transfer. No resumable-upload protocol exists | `apps/api/vercel.json` vs `scripts/vercel-bundle.mjs:45,56` | Decided: config fix + chunked design (Q12); daemon treats SSE as capped segments with resume |
| L4 | SSE relay has no heartbeat; idle streams die silently at NATs/LBs; web app survives only via browser `EventSource` auto-reconnect | `agent.ts:900-936` (no keepalive); `spa/api/stream.ts` | Decided: new route adds comment-ping; daemon adds read-idle watchdog + persisted cursor |
| L5 | Per-request control-plane cost: every file op = Convex **mutation** patching the same `apiKeys.lastUsedAt` row + a `gatewayConnectionBySlug` query. 50k-file clone = 50k serialized writes to one doc | `apps/api/src/index.ts:112`; `domains/apiKeys/api.ts:29-47`; `client.ts:255` | Decided: tar-stream clone (Q12); **escalated**: throttle/async `lastUsedAt`, cache gateway resolution |
| L6 | Torn reads: agents write in place directly on disk; GET streams a pre-open stat's `content-length` (shrink ⇒ hang, grow ⇒ truncation); GET ignores `If-None-Match` entirely | `files.ts` GET path (`:200-247`); headers forwarded but unused | Sharp edge: daemon verifies etag before/after download, length-checks, retries; prefers write-quiesce via feed |
| L7 | mtime cannot be set on PUT, isn't in the write response, and is second-precision on the wire — mtime is never the sync clock | `files.ts:82-130` (response `{ok, etag, size}`), `:590` | Sharp edge: local state DB maps `path → (local mtime, remote etag, hash)`; hash carries identity. File-event `size`/`mtimeMs` were later removed as misleading partial observations; the fleet-skew invariant lives in the [closed schema-cleanup record](../schema-cleanup/README.md#runtime-contracts-move-coherently). |
| L8 | Path grammar vs APFS: no Unicode normalization, no case folding, **backslash silently becomes `/`**, no length cap. macOS: case-insensitive volumes + NFD ⇒ collisions, phantom dupes, sync loops | `contract/src/drive/index.ts` `normalizeDrivePath` | Sharp edge: daemon owns the normalization contract — NFC-canonical, detect case/normalization collisions and surface them, refuse backslash names |
| L9 | Hardlinks poison identity: shared etag (ino-keyed), ctime cross-talk (write via A invalidates B's etag with no event on B), fanotify shares one handle across names, footprint double-counts, anchor scanner sees live links as rename candidates | `files.ts:640`, `boundedTreeFootprint:490`, `routes/anchors.ts:218,300` | Decided (Q14 content copies); watcher hardlink ambiguity accepted |
| L10 | Syncthing split-brain: VM↔VM shares sync symlinks natively, landing links on drives the REST API then refuses to list/serve; mount guards reject symlinked share roots | `routes/sync.ts:139-150`; `sync/mounts.ts:65-116` | Noted: Q13 sub-spec must align the two transports (or `.stignore` links out of shares) |
| L11 | fanotify symlink event semantics unproven — the FID spike exercised only regular files/dirs; `open_by_handle_at` behavior for link handles unknown | [research/fanotify-fid-spike.md](research/fanotify-fid-spike.md); slice-13 probe: [research/fanotify-links-probe.md](research/fanotify-links-probe.md) | **Resolved GREEN** (slice 13): link ops are named dirent events; through-link content carries the target FID; link handles resolve with O_PATH (plain open = ELOOP) |
| L12 | `.git` under concurrent two-sided writes corrupts (index/lock/refs churn); single-sided use is fine | domain knowledge; actor tags enable "agent is committing" awareness | Sharp edge, accepted under true mirror |
| L13 | Mac-side: FSEvents needs file-level flags + overflow rescan; Mac sleep/wake = same resume path as SSE drops; hashing 25–100GB is IO-bound once, incremental after | domain knowledge | Sharp edge; manifest reconcile covers all three |

## Escalations (independent of this feature)

1. **Archive restore rejects links** (L2) — dev workspaces can't be restored
   from retirement today.
2. **`apps/api` missing `VC_MAX_DURATION`** (L3) — bites agent-session SSE
   already, not just sync.
3. **`authenticate` hot-row mutation + uncached gateway resolution** (L5) —
   every API consumer pays it.
4. **Disk cap mismatch**: code 10GB vs product 25→100GB (Q16 context).

## Builder must confirm before coding

- File-attribution slice 01 not landed: get Q10 (mirror actor) and Q11
  (size/mtime on events) into the vocabulary before it ships.
- ~~Probe fanotify symlink/hardlink event semantics on a real VM (L11)~~ —
  done, GREEN: [research/fanotify-links-probe.md](research/fanotify-links-probe.md).
- Verify the feed route can serve without ticking `lastActivityAt` (Q3) and
  pin with a test.
- Confirm tar subtree streaming interacts sanely with `MAX_RECURSIVE_*`
  limits (`contract/src/files/index.ts:3-4`) — bulk endpoints likely need
  their own bounds, not the 512MiB/1000-entry action caps.
- Decide the SSE route's event kinds exposed to clients (writes/creates/
  deletes/renames/restore; read markers filtered out for sync consumers?).

## Tweakable build plan (sorted by likelihood you'll tweak, not by order)

1. **Symlink sub-spec** (Q13/L1/L2/L10) — contract shape, route semantics,
   archive policy. Biggest judgment area; also carries the L2 product fix.
2. **SSE feed route** — path, cursor grammar, keepalive cadence, event
   filtering, docs page. (Q1/L4)
3. **Manifest + hash cache** — NDJSON shape, BLAKE3 cache placement in the
   gateway state dir, lazy-hash policy. (Q5)
4. **Tar-stream clone endpoint** — subtree chunking, resume, bounds. (Q12)
5. **Key model relaxation** — user-wide key kind, per-device identity,
   `mirror:<deviceId>` actor, web surface, SECURITY.md. (Q4/Q10/Q15)
6. **Daemon engine** — local state DB, FSEvents watcher, NFC/collision
   contract, conflict copies, echo suppression, junk excludes, free-space
   check. (Q6/Q7/L6-L8/L13)
7. Mechanical (trusted): launchd install, npm versioned release pipeline,
   `VC_MAX_DURATION` config, activity-neutrality test.

## Amendment log

**2026-07-13 — Direction C adopted (Example User): stock Syncthing, wrapped and
unforked, becomes the ONE transfer plane for VM↔VM and VM↔Mac.** The
architecture review asked whether two sync systems (Syncthing for VM↔VM, a
custom REST/SSE protocol for VM↔Mac) could unify; Example User chose unifying on
Syncthing. Amended decisions:

- **Q1 (transport) — amended for the transfer plane.** File bytes move over
  Syncthing BEP through the existing sync-tunnel WS bridge (reusable TS in
  `packages/sync-tunnel`, now also a daemon dependency); the SSE feed
  survives as the **product observation API** (slice 17), no longer
  sync-critical. Corrected territory fact: the edge-WS gap never blocked a
  Mac device — tunnels connect gateway-to-gateway over each VM's public
  `httpsUrl`, where Bun speaks WS natively; a Mac can do the same.
- **Q5 (manifest + hashes) — dropped.** Syncthing's index exchange and block
  sync own reconcile; no server-side hash cache, no manifest endpoint.
- **Q12 (tar clone) — dropped.** Syncthing's initial sync is resumable and
  block-deduplicated.
- **Q6 (conflicts) — amended.** Conflict copies keep Syncthing's native
  `.sync-conflict-*` convention (already the product's VM↔VM convention);
  the daemon surfaces them in `status`. Never-lose-bytes principle
  unchanged.
- **Q4/Q10/Q15 — retained, rebound.** The user-wide per-device credential
  now also binds the device's Syncthing device ID; `mirror:<deviceId>`
  attribution comes from Syncthing's `RemoteChangeDetected.modifiedBy`
  (verified: [docs.syncthing.net/events/remotechangedetected.html](https://docs.syncthing.net/events/remotechangedetected.html))
  translated by the gateway — replacing L10's temp-file classification with
  semantic events (the L9 pattern extended to Syncthing).
- **L8 (APFS normalization/case), L6 (torn reads), L13 (FSEvents), free
  space — absorbed by Syncthing**, which handles normalization,
  case-insensitive filesystems, block verification, watching, and
  `minDiskFree` natively; the client-side mitigation layer is deleted.
- **Sequencing win:** Syncthing watches the VM disk itself, so the mirror
  sees agent edits from day one — the mirror no longer depends on the
  kernel-watcher ladder (slice 11); only attribution UI does.

Grounded Syncthing facts (primary docs, 2026-07-13): the events API is HTTP
**long-polling with a `since=<id>` sequential cursor** and bounded buffer —
gaps are detectable as ID discontinuities
([docs.syncthing.net/rest/events-get.html](https://docs.syncthing.net/rest/events-get.html));
there is no WebSocket API; `RemoteChangeDetected` must be selected via an
events mask and carries `modifiedBy`, `path`, `folder`, `action`.

New landmines this direction introduces (carried into the slices):

- **L14 — Syncthing's admin/events API is a localhost single-tenant admin
  surface** (one static key, full config mutation): it must never be exposed
  beyond the VM/Mac loopback; the gateway (VM) and daemon (Mac) are its only
  consumers, and the public event vocabulary stays Duet's (translation in
  one place).
- **L15 — Syncthing event IDs are process-local and in-memory** (reset on
  restart, bounded buffer): they are consumption cursors, never durable
  public cursors — the durable cursor stays the Convex per-workspace seq.
- **L16 — Syncthing identity/db must survive archive→restore** (else a
  restored VM presents a new device with an empty index → full re-scan and
  conflict risk): where the gateway places Syncthing's home relative to the
  archived `stateDir` is a builder-confirm before slice 19.
- **L17 — activity semantics:** remote-originated Syncthing changes must
  tick `recordActivity` (a workspace edited only from a Mac must not hit
  the 7-day GC), while idle tunnel connections and Syncthing's own scan
  reads must not (sleep-transparency, Q3).

## Amendment log — walk 2 (2026-07-13, post-Direction-C re-walk)

A second quadrant walk over the C-shaped spec; evidence in
[research/syncthing-operations.md](research/syncthing-operations.md).
Decisions (all Example User):

- **V1 — version strategy:** pinned official Syncthing release (v2.1.x
  line) on both sides — SHA-verified download replaces unpinned apt in
  vm-image; Mac bundles the same pin; `STNOUPGRADE` +
  `autoUpgradeIntervalH=0`; versions move together via image + npm
  releases.
- **V2 — hardening ownership:** vm-image `ExecStartPre` generates identity
  and writes the hardened config **before Syncthing's first listen** (the
  audit found hardening is lazy today — L14 was already broken:
  discovery/relays/NAT/crash-reporting live on fresh VMs); the gateway
  boot-reconciles the same options as semantic owner.
- **V3 — restore × mirrors:** restore stops `duet-syncthing` around the
  drive swap (`.stfolder` semantics would otherwise broadcast the
  half-empty tree as deletions to connected mirrors — new landmine L18).
- **K1–K10 knob set accepted** (see research doc §B): `/rest/events/disk`
  source; async batched scan nudge (endpoint is synchronous); mirror
  `fsWatcherDelayS=1` (≤0 disables — test-pinned); vm-image sysctl
  `max_user_watches=204800`; **K5 corrected to `ignorePerms=false`**
  (`true` strips the exec bit → git mode noise); case/mtime safety
  defaults kept; `maxConflicts=10` explicit; xattrs/ownership off;
  loopback `tcp://192.0.2.1:22000` listener; Mac binaries bundled via npm
  `optionalDependencies` (~12MB/arch, upstream-notarized, MPL NOTICE).
- **G1 — git policy (amends Q7's "true mirror — everything"):** `.git` and
  `node_modules` are **excluded from the mirror**. Research verdict
  (research doc §C): bidirectional `.git` under two active writers is
  maintainer-confirmed unsafe; worktree absolute paths and wrong-arch
  node_modules binaries break deterministically. Worktree files keep
  live bidirectional sync; git history travels via real remotes; the
  shared-worktree discipline (same branch both sides; `git pull` catches
  local bookkeeping up to already-synced files) is documented, not
  enforced. Repos without a remote have no history path to the Mac —
  docs nag to add one.
- **G2 — git concierge: named deferred slice** (not in the v1 ladder):
  auto-bootstrap (`init`/`remote add`/`fetch`/`reset --mixed`, gated on
  folder convergence — never against a half-synced tree), align-when-safe
  branch following (only when the following side is clean + idle),
  loud divergence in `status`. "Always-synced branches" rejected: it
  reintroduces two-writer `.git` coordination with a policy for whose
  work gets destroyed. "Exclude repo files entirely, rely on git"
  rejected: hollows the mirror's liveness value and adds
  dynamic-subtree-exclusion surprises.
- **Upgrade posture (default, unobjected):** bump the pin on security
  advisories, opportunistic minors; every bump gated by slice-18's
  event-shape checks and a staging soak.
- **Pre-ship context:** no live-fleet migration story needed — next image
  rebuild is the fleet story.

New landmines from walk 2: **L18** restore-deletion broadcast (→V3);
**L19** unpinned/auto-upgrading Syncthing (→V1); **L20** first-boot
unhardened window (→V2); **L21** silent watcher degradation at default
inotify limits (→K4); **L22** `fsWatcherDelayS≤0` silently disables the
watcher (→K3 test pin); **L23** tunnel-token TTL (~5min) vs Syncthing
reconnects — every reconnect dials a fresh WS, so the daemon/bridge must
re-mint tokens on reconnect, not cache one; **L24** Mac instance should be
dial-only (empty listener) — it only ever dials the loopback bridge;
**L25** `maxFolderConcurrency` defaults to nCPU=1 on workspace VMs — many
mirror+share folders serialize scans (accepted; revisit with fan-out).

## Status

Map complete (2026-07-13), absorbed into this spec the same day: the
[README](README.md) ladder carries the sync slices, and slice 01 absorbed
Q10/Q11 before landing. Amended the same day to Direction C, then by
walk 2 (see Amendment logs). This file remains the binding decision record
for the sync decisions, as [MAP.md](MAP.md) is for attribution.
