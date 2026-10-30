# Workspace drive: attribution + sync — rationale record

**Status: shipped** (22 slices, branch `spec/file-attribution-sync`). This
document is the *why* and the *what-must-hold*. The code is the source of
truth for *how*; every claim below points at the module or test that owns it.

## What shipped

Two capabilities over the workspace drive (POSIX files on an exe.dev micro-VM
at `/home/synthetic-user/drive`), built on **one event backbone and one transfer
engine**:

1. **Attribution.** Every read and write of a drive file is attributed to a
   duet identity — web users, API keys, agent sessions (including anything the
   agent execs via bash), interactive terminals, share peers, mirror devices,
   and the platform itself — and surfaced in the Files SPA and as a durable,
   seq-ordered public observation API (REST history/seen-by/feed + a resumable
   SSE stream).
2. **Mirror.** A registered device (v1: a Mac running `duetfs sync`) mirrors a
   workspace's whole drive Dropbox-style. File *transfer* is stock, unforked
   **Syncthing** — the same engine that already syncs VM↔VM shares, now the one
   transfer plane for VM↔Mac too.

The unifying idea: **one pipeline, one vocabulary, one sequence, one transfer
engine.** Gateway routes, the kernel watcher, and the Syncthing event
translator all feed a single recorder; the SPA, the query surface, the SSE
feed, and sync status are all consumers of it — never parallel systems. Every
*observation* speaks Duet's vocabulary even though *transfer* is Syncthing's:
Syncthing's localhost events are translated into Duet events in exactly one
place, at the gateway.

## The reasons — why it's shaped this way

**Why one transfer engine (Direction C).** The original plan had a custom
VM↔Mac protocol (manifest + hash cache + tar-stream clone) alongside Syncthing
for VM↔VM. That was two transfer planes to build, harden, and reason about.
Wrapping stock Syncthing for *both* collapsed them: Syncthing already handles
resumability, conflict detection, delta transfer, and bidirectional sync — all
the hard parts. Duet owns supervision, orchestration, attribution, and
presentation; Syncthing owns transfer semantics. The custom manifest/tar/clone
endpoints were deleted from the plan before implementation. The cost of the
choice is a hard firewall (below): Syncthing's admin API must never leak past
loopback, and its event IDs must never become a durable cursor.

**Why the kernel watcher exists at all.** API-path writes (web/MCP/duetfs/
api-key) are attributed cheaply at the gateway route — the actor is known from
the authenticated request. But an agent that runs `bash -c "echo x > f"` writes
through the kernel, not the API, so there is no request to attribute. A
privileged fanotify watcher closes that gap: it maps kernel file events back to
the session cgroup that caused them. This is the single hardest, riskiest part
of the system, and it drove the two probe-first slices.

**Why cgroup identity with zero registration.** The watcher must answer "which
session touched this file" without the gateway telling it about every session.
Session runners are placed in `/sys/fs/cgroup/runners/<leaf(sessionId)>`, and
the leaf name *is* the interface — the watcher reverse-maps leaf → session with
the same pure function the gateway uses to name it
(`cgroupLeafForSession`/`sessionForCgroupLeaf`,
`packages/gateway/src/runner/cgroup.ts`). No registration RPC, no shared state.

**Why "semantic events win."** A single write can be seen twice — once by the
kernel watcher and once as a gateway route event or a Syncthing translation.
Duplicates are resolved structurally, not by dedup heuristics: the watcher
drops events from the gateway's own pid *and* Syncthing's pid in-helper, so an
API write appears exactly once (as the route's semantic event) and a synced
write appears exactly once (as the slice-18 translation). Proven end to end by
`research/attribution-e2e.md` (assertions D and E).

**Why sleep-transparency.** exe.dev VMs never sleep; they are garbage-collected
after 7 days idle. An always-on mirror that reads files to replicate them would
tick activity forever and defeat the GC — a workspace nobody uses would never
retire. So mirror *reads* are activity-neutral (and emit no attribution markers
at all — they are mechanical replication, not attention). But mirror *writes*
do tick activity: an edit arriving from someone's Mac is genuine use, and
without it a Mac-only-edited workspace would wrongly hit the 7-day GC.

**Why a user-wide credential for sync (and why that's the one exception).**
Every other Duet credential is scoped to a single workspace. A mirror daemon
syncing all of a user's workspaces would need a fistful of per-workspace keys
that churn as membership changes. Instead `sync_device` is one credential per
device, valid across the user's live memberships, capability-floored to files.
The blast radius is real and documented honestly (`SECURITY.md`): a stolen sync
credential can read every synced `.env` and write executable source across all
the user's workspaces, and its read-only exfiltration leaves no per-file audit
trail (the mirror-read carve-out). That honesty is the point — the floor is
load-bearing and may never widen without a `SECURITY.md` change in the same
diff.

**Why symlinks became first-class (and why it was urgent under Direction C).**
A mirror syncs real dev trees full of symlinks onto the drive whether or not
the REST file model can represent them. Before this work, listings `stat()`ed
each entry so a symlink showed as its target and a dangling link was silently
*omitted* — which a mirror would read as a phantom deletion and propagate. The
files surface now represents links as links (lstat-based), and the archive
round-trips them. This also fixed a **live product bug**: link-bearing
workspaces (every `node_modules/.bin`, every git hook) were unrestorable after
retirement because `assertSafeTarEntries` rejected the exact tar typeflags the
archiver emitted.

## Invariants — what must stay true

These are enforced in code and pinned by tests. Breaking one silently breaks
the feature.

- **One actor vocabulary.** `packages/contract/src/file-attribution/` owns the
  seven-kind actor grammar, the event schemas, the read-bucket math, and the
  file-event cursor. No other module re-derives the string grammar. Actor kinds:
  `session:` `api-key:` `web:` `sync:<shareId>` `mirror:<deviceId>` `terminal`
  `system`. `sync:` (share peers) and `mirror:` (mirror devices) are distinct
  and never conflated.
- **Clients never supply actor identity.** The actor header is synthesized
  server-side from authenticated state in exactly one place
  (`apps/api/src/gateway/actor.ts`), *after* the forwarded-header whitelist copy,
  and must never appear in any forwarded-header list. A regression test pins that
  a client-supplied `x-duet-actor-context` never reaches the gateway.
- **One durable cursor.** The public cursor is the Convex per-workspace `seq`,
  monotonic-per-workspace (pinned by a dedicated test in
  `packages/backend/convex/domains/fileActivity/`). Syncthing's own event IDs
  are process-local consumption state only — a gap is a counted loss, never a
  durable-cursor pretense. REST history, the SSE feed, and every daemon resume
  point ride the one `fe1:<seq>` cursor grammar.
- **Feed order and scope are views over that cursor, not new streams.** The public
  feed remains workspace-wide and ascending by default for durable consumers;
  recent-activity readers may traverse descending and constrain the same sequence
  to one file or a folder subtree. Renames match either path and restores match
  every scope, so filtering never erases an event that changed the selected subject.
  Folder membership is an asynchronous, rebuildable projection of the durable
  event log: new rows schedule their own projection, a bounded sweep repairs old
  or interrupted rows, and readers retain the direct-log path until that workspace
  is fully projected.
- **Syncthing stays loopback.** Its admin/events API is consumed only by the
  gateway (VM side) and the duetfs supervisor (Mac side), never exposed,
  proxied, or forwarded. The public vocabulary is Duet's, translated once per
  side (`packages/gateway/src/attribution/syncthing-events.ts` in;
  `packages/duetfs/src/sync/status.ts` out).
- **Reads are markers, not logs.** A read event means content was actually
  fetched (no list/stat/`FAN_ONDIR`); repeat reads by one actor collapse to one
  marker per 6-hour bucket. The *one* carve-out: `mirror` actors emit no read
  markers, enforced solely through the contract predicate `actorEmitsReadMarkers`
  (never a hardcoded `'mirror'` literal anywhere).
- **Semantic events win.** API operations and Syncthing operations each appear
  exactly once; the watcher drops gateway-pid and syncthing-pid events
  in-helper before any handle open.
- **The mirror is total except machine-local state.** `.git` and `node_modules`
  never mirror (G1 — machine-local: wrong-arch binaries, worktree gitdir
  breakage, index inode ping-pong); `.env*` *does* mirror (personal mirror,
  unlike the share default). macOS junk is excluded Mac-side.
- **Link safety.** No route, archive, or sync path ever *follows* a symlink
  across the drive boundary; containment stays `normalizeDrivePath` + the
  existing realpath walk. Link targets never influence containment decisions.
  Hardlinks are content copies, never inode-shared (Syncthing behaves the same).
- **Attribution is product-grade, not tamper-proof** against code running as
  `exedev`. No part of the system claims otherwise.

## The docs-first design gate (a process that shaped the API)

Every public-surface slice (query API, symlinks, SSE feed, mirror API, sync
credential, sync daemon) wrote its `apps/docs` page **first**, then had an
unprimed subagent — one that saw only the drafted page and the existing docs
corpus, never this spec — review it as an outside API consumer before any code
existed. This caught real design defects while they were still cheap:

- `mtime` on events collided with the files API's ISO-string `mtime` → renamed
  to `mtimeMs` (one name must not carry two types).
- `restore` events carried an empty-string `path` sentinel that read as a real
  path → they now carry no path.
- Symlink read/write errors were unnamed → anchored to `409 symlink_unresolvable`
  / `409 path_is_symlink` with the error body carrying the link target.
- The sync-credential blast-radius write-up was soft-pedaled ("far shallower
  than a workspace key" — the inverse of the truth) → rewritten honestly.

The reviewed drafts live in `assets/docs-draft-*.mdx`; the shipped pages are
under `apps/docs/app/`.

## Dead ends (do not re-walk)

- **proc-connector fork map — dead at the kernel level.** The original design
  tracked process ancestry via a netlink proc-connector (fork/exec/exit) to
  attribute short-lived processes. The exe.dev image ships
  `# CONFIG_CONNECTOR is not set`, so `socket(AF_NETLINK, …, NETLINK_CONNECTOR)`
  fails `EPROTONOSUPPORT` for *any* userspace — bun:ffi and the pre-planned
  python3-ctypes fallback alike (same kernel interface). Evidence:
  `research/proc-connector-probe.md`. **Open escalation:** if exe.dev ships
  `CONFIG_CONNECTOR=y` + `CONFIG_PROC_EVENTS=y`, the fork map returns as the
  simpler primary mechanism and the pinning group below is deleted — the design
  is mechanism-agnostic below the resolver, so this is reversible.
- **The replacement that shipped — FAN_OPEN_PERM pid pinning.** A second,
  mount-scoped fanotify group with `FAN_OPEN_PERM` observes (never authorizes)
  every file open: while the opener is blocked on the permission response, its
  `/proc/<pid>/cgroup` is read race-free and cached, then `FAN_ALLOW` is sent
  immediately. cgroup membership is inherited, so this attributes short-lived
  `sh -c` children the fork map was meant to catch — 20/20 in the probe, the
  case the first spike lost 0/20 (`research/fan-open-perm-probe.md`,
  `research/helper-probe.md`).
- **A watcher that opens readable handles self-amplifies to OOM.** A
  non-`O_PATH` handle open on the watched filesystem emits its own FAN_OPEN,
  which the watcher then handles by opening another handle — RSS climbs
  linearly with events. The helper's self-pid drop and `O_PATH`-only
  resolution are load-bearing, not hygiene: with them, RSS plateaus (≈4.7 MB
  steady-state drift across a gated-open storm). Evidence:
  `research/fan-open-perm-probe.md` §4 and `research/helper-probe.md` §8.
- **The NOTIF group watches the whole filesystem, so discarding is the hot
  path.** `FAN_REPORT_FID` forbids a mount mark, which is why the perm group
  can be scoped to the drive bind mount but the NOTIF group cannot: it must be
  `FAN_MARK_FILESYSTEM` and then drop what falls outside the drive. Since the
  mask includes `FAN_CLOSE_NOWRITE` — the content-read signal — the helper sees
  every read-close by every process on the VM, and on an idle workspace
  essentially all of them are discards. Resolving a handle costs an
  `open_by_handle_at` plus a `readlink`, so paying it per event made an idle VM
  cost real CPU. Resolution is therefore cached on the codec's `handleKey`,
  including negative results. What makes the cache safe is the same
  filesystem-wide mark that causes the problem: no rename can happen without
  the helper seeing it, so an entry drops its own key on a move and a moved
  *directory* drops the whole cache, since it renames every path beneath it.
- **Custom VM↔Mac transfer protocol — dropped at Direction C.** Manifest
  endpoint, hash cache, and tar-stream clone were all removed from the plan when
  stock Syncthing became the one transfer plane.
- **`(?d) **/node_modules` — a real bug caught in the slice-21 E2E.** The space
  after `(?d)` silently defeats Syncthing's matcher and leaks `node_modules`.
  Fixed to `(?d)**/node_modules` in the shared `packages/contract/src/mirror/`.

## Boundaries and accepted degradations

- **Open-less operations (`rm`, `mv`, `ln -s`) attribute coarsely.** They
  involve no `open(2)`, so the perm-pin never sees them; a bare `rm foo` whose
  pid escaped the pin resolves to `terminal` rather than the agent session. The
  path is *always* correct — only the actor label degrades (session → terminal),
  never mis-filed. Accepted because delete/rename are the rarest write class and
  the real cure is the CONFIG_CONNECTOR escalation. Owned by
  `packages/gateway/src/attribution/actor-resolver.ts`, pinned by test.
- **The drive needs a mount-scopeable boundary.** On the exe.dev image the drive
  shares the root superblock, so the blocking `FAN_OPEN_PERM` group is
  mount-scoped via a bind mount the helper owns (a filesystem-wide perm mark
  would gate the whole VM; FID-mode NOTIF marks reject `FAN_MARK_MOUNT`, hence
  the two groups differ). `research/fan-open-perm-probe.md`.
- **Loss is bounded and counted, never spooled.** Event buffers are in-memory;
  a gateway restart drops in-flight events. Every loss is counted (overflow,
  dropped reads, cgroup misses, syncthing-event gaps, helper restarts) and relay
  retries carry a stable `batchId` so "never drop writes" can't become
  "duplicate writes."
- **The Mac runs one Syncthing instance per workspace.** The VM folder id is the
  fixed `workspace-drive`; to avoid folder-id collisions on a Mac mirroring
  several workspaces, the daemon isolates one instance per workspace under
  `~/.duet/sync/workspaces/<slug>/`.

## Follow-ups (shipped as runbooks / open decisions, not code)

- **Retention (MAP Q11).** No pruning cron ships. Slice-11 stood up the data
  source (`attribution-stats` log line every 5 min); a week of staging volume
  data decides the cadence. When pruning lands it must yield a detectable
  "cursor too old" signal, never a silent gap.
- **Live retire→restore round-trip (L16).** Verified by construction — the
  Syncthing home lives inside the archived `stateDir`, so device identity +
  `index-v2` survive the archive. The full live register→retire→restore probe is
  a documented runbook (needs a provisioned VM + Convex).
- **Full-stack staging demos.** The slice-11 E2E ran the production kernel path
  with a stub relay; the slice-21/22 E2Es ran real Syncthing locally. The
  Convex-polling, live-WAN-tunnel demos are runbooks.
- **Git concierge (G2).** Auto-bootstrapping excluded `.git`s (init/remote/
  fetch/reset) and align-when-safe branch following is a named deferred slice;
  v1 documents the shared-worktree discipline instead (`apps/docs/app/sync/`).
- **Read-only sync device.** v1's mirror is bidirectional by protocol; a
  receive-only grant is named future work.
- **Syncthing pinned to v2.1.2**, both sides, sha256-verified. Upgrade posture:
  bump on security advisories, gate each bump on the slice-18 event-shape
  re-check (`research/syncthing-v2-pin-probe.md`) + a staging soak.
- **apps/api `VC_MAX_DURATION=800`** (slice 14) takes effect on the next deploy;
  it fixes a live bug where the platform's default duration decapitated the
  existing agent-session SSE at ~300 s (`research/vercel-transport-probe.md`).

## Map into the code

| Concept | Owner |
|---|---|
| Actor grammar, event schemas, read buckets, cursor, read-marker predicate | `packages/contract/src/file-attribution/` |
| File-kind vocabulary (`file`/`directory`/`symlink` + target) | `packages/contract/src/files/` |
| Mirror ignore patterns, folder knobs | `packages/contract/src/mirror/` |
| Sync-device scope grammar (`user:files:*`, `assertSyncDeviceScopes`) | `packages/contract/src/scopes/` |
| Durable store, seq allocation, read-marker dedupe, rollup, queries | `packages/backend/convex/domains/fileActivity/` |
| `sync_device` credential kind, device identity, issuance, revocation | `packages/backend/convex/domains/apiKeys/` |
| Actor synthesis at the trust boundary (sole header producer) | `apps/api/src/gateway/actor.ts` |
| File-activity HTTP surface (REST + SSE) | `apps/api/src/routes/file-activity.ts` |
| Event buffering, coalescing, flush, loss counters, mirror-read drop | `packages/gateway/src/attribution/pipeline.ts` |
| Syncthing→Duet translation + sync activity policy | `packages/gateway/src/attribution/syncthing-events.ts` |
| Duet→Syncthing scan nudge (loop-guarded) | `packages/gateway/src/attribution/scan-nudge.ts` |
| fanotify byte decoding + rename/temp-file join (pure) | `packages/gateway/src/attribution/fanotify-codec.ts` |
| Privileged kernel watcher (FID NOTIF + mount-scoped perm pinning) | `packages/gateway/src/attribution/helper-main.ts` |
| Helper⇄gateway NDJSON protocol (versioned) | `packages/gateway/src/attribution/helper-protocol.ts` |
| Helper supervision + release packaging | `packages/gateway/src/attribution/helper-supervisor.ts` |
| OS-event → actor policy | `packages/gateway/src/attribution/actor-resolver.ts` |
| Session cgroup leaf naming + drain/GC | `packages/gateway/src/runner/cgroup.ts` |
| Route link discipline + activity policy | `packages/gateway/src/routes/files.ts` |
| Tar-entry policy (archive create + restore, symmetric) | `packages/gateway/src/vm/archive.ts` |
| Sync path→share/device registry (the one registry) | `packages/gateway/src/sync/mount-store.ts` |
| Store→syncthing-config projection (store wins) | `packages/gateway/src/sync/reconcile.ts` |
| VM Syncthing lifecycle, folders, devices, provisioning, hardening | `packages/gateway/src/routes/sync.ts` + `sync/` |
| Tunnel framing + TCP↔WS bridge (VM↔VM and Mac↔VM) | `packages/sync-tunnel` |
| Mac wrapper: binary, supervisor, bridge, orchestrator, status, run | `packages/duetfs/src/sync/` |
| Mac daemon: multi-workspace, launchd, releases | `packages/duetfs/src/sync/daemon.ts` |
| SPA attribution presentation | `apps/web/spa/files/attribution.tsx` + `activity-feed.tsx` |

Binding decision ledgers with the full question-by-question rationale and the
landmine cards: [MAP.md](MAP.md) (attribution walk) and
[MAP-SYNC.md](MAP-SYNC.md) (drive-sync walk, incl. the Direction C amendment
log). Probe evidence and verdicts: [research/](research/). The UI design target
that drove the Files SPA directions:
[assets/attribution-directions-mock.html](assets/attribution-directions-mock.html)
(the exploration mock — directions A/B became the list column + seen-by strip,
C/D became the history drawer + activity feed).
