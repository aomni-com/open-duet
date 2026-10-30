# File attribution — exploration map

Product goal: attribute every read and write of workspace-drive files to a duet
identity — including files touched by whatever an agent execs — and surface it
in the product. Produced by a quadrant walk (2026-07-10 → 2026-07-12); feeds a
future write-spec session. Spike evidence lives in [research/](research/).

## 1 · Known knowns — settled ground

- Drive files are plain POSIX files on the workspace VM (`/home/synthetic-user/drive`,
  `packages/vm-image/systemd/duet-gateway.service`); no per-file DB rows exist.
- Access paths: the api files proxy (auth at
  `apps/api/src/routes/workspaces.ts` — MCP and duetfs ride it via API keys,
  `apps/mcp/src/tools/files.ts`), agent sessions (runner-spawned, per-session
  cgroups, `agentSessions.userId`), syncthing share mounts, and terminal/SSH.
- exe.dev VM kernel 6.12.93; passwordless sudo; full systemd. bun:ffi can
  drive fanotify end to end ([fanotify spike](research/fanotify-spike.md)).
- auditd captures everything but cannot attribute short-lived processes
  (post-hoc pid→cgroup: 0/20) — ruled out
  ([auditd spike](research/auditd-spike.md)).
- Per-session runner cgroups existed in code but were dead in production
  (env var never set) — fixed during this walk, see landmine L1.
- `auditEvents` stays control-plane; file telemetry gets its own tables.
- Attribution is product-grade, not tamper-proof: in-VM code running as
  `exedev` can forge at the OS level. Accepted.

## 2 · Known unknowns — decision ledger

| # | Question | Decision | Closed by |
|---|----------|----------|-----------|
| Q1 | Unattributed OS events | Log writes only (`terminal`/`system`/`sync`); drop unattributed reads | Example User |
| Q2 | Capture mechanism | fanotify via sudo-run Bun helper (bun:ffi); mount mark on bind-mounted drive | Spikes + Example User |
| Q3 | Short-lived pid attribution | Live pid→session map from proc-connector fork events, seeded by session cgroups. **Slice-13 probe RED** ([research/proc-connector-probe.md](research/proc-connector-probe.md)): exe.dev kernel has `# CONFIG_CONNECTOR is not set` — no runtime can use the connector; escalate + reslice 09 per the slice-13 fallback | Example User; slice-13 probe |
| Q4 | Convex landing | `fileEvents` (append: writes/deletes/renames + read markers) + `fileAccess` rollup (optional optimization) | Example User |
| Q5 | API identity | Proxy forwards actor to gateway; gateway owns the single event pipeline. Header **synthesized from `auth` after the whitelist copy** — never a `forwardedHeaders` entry (L4) | Example User + sweep |
| Q6 | Coalescing/transport | ~5s or 500-entry in-memory flush via existing gateway→api relay; never drop writes; drop-oldest-reads with counter | Example User |
| Q7 | Read semantics | Durable read markers, one per `(path, context)` per time bucket, uniform for ALL actors (no human/agent special-casing); **content reads only** — dir listings/stat/`FAN_ONDIR` excluded | Example User (stage 3 + D2) |
| Q8 | Actor contexts | `session:<id>`, `api-key:<keyId>`, `web:<userId>`, `terminal`, `sync:<shareId>`, `system`; per-context read rows, `userId` column for per-user queries | Example User |
| Q9 | Watch scope | Drive only. No bind mount: dirent/rename events require `FAN_MARK_FILESYSTEM` (mount marks reject them, FID spike), which is superblock-wide regardless — the helper's drive-prefix filter is the scoping mechanism | Example User + FID spike |
| Q10 | Sync attribution | `sync:<shareId>` by path prefix; make `sync-mounts.json` the single authoritative registry (L11) | Example User + sweep |
| Q11 | Retention | **CLOSED** by [file-activity-folding](../file-activity-folding/README.md). The volume data this was waiting on arrived and reframed it: pruning alone was never the answer, because the rows that hurt are recent. Folding bounds how many rows a burst can make; a 30-day prune bounds how long any of them live | file-activity-folding |
| Q12 | Rename/delete visibility (D1) | **RESOLVED — spec unblocked.** FID spike all-green on kernel 6.12.93 ([research/fanotify-fid-spike.md](research/fanotify-fid-spike.md)): one `FAN_CLASS_NOTIF \| FAN_REPORT_FID \| FAN_REPORT_DFID_NAME \| FAN_REPORT_TARGET_FID` group with a `FAN_MARK_FILESYSTEM` mark carries content + dirent + `FAN_RENAME` together; deleted paths resolve via parent handle + name; atomic saves (shell `mv` and `os.replace`) reconstruct to the real filename with the writer pid via a handle-to-writer join. Gotchas in the report: `open_by_handle_at` needs an `O_RDONLY` (not `O_PATH`) mount fd; dedupe `FAN_RENAME` vs legacy `MOVED_FROM/TO` bits | Spike |
| Q13 | Write containment | Separate spec — bootstrapped at [specs/write-containment/](../../write-containment/README.md) | Example User |

Simplifications explicitly chosen (optimize for net-simplest architecture):
- Agent-boot file activity (between spawn and cgroup placement) may go
  unattributed — no atomic stopped-child handoff required.
- Gateway restart may lose the in-flight event buffer — helper runs as a
  gateway-managed child with in-memory buffering; no durable replay queue.

## 3 · Unknown knowns — extracted context

- **All four UI directions stolen** (list column, preview strip, history
  drawer, activity feed — mock: exploration artifact `attribution-directions`).
  Amendment: reads appear inline in the history timeline, which is what forced
  durable bucketed read markers (Q7).
- **Consumers: all four** — including programmatic (MCP/API) ⇒ attribution
  needs a query surface (file history + seen-by over the API), not just UI.
- **First surface: Files SPA** (`apps/web/spa/files/`) — directions A+B ship
  first.
- **Done looks like:** "teams trust shared drives because edits are
  accountable" ⇒ unattributed terminal writes are a hole in the core promise;
  the write-containment spec is part of the trust story, not a nice-to-have.
- **Privacy:** internal names/emails visible to share recipients is fine for
  now; a "hide file timeline" share option is future work.

## 4 · Unknown unknowns — landmine cards

| # | Landmine | Evidence | Status |
|---|----------|----------|--------|
| L1 | Runner cgroups never ran in production: gated on `DUET_RUNNER_CPU_RESERVED_CORES` which the systemd unit never set; leaves are pid-named, not session-named | `runtime/http.ts:60`, `runner/cgroup.ts:55` | **Fixed** (env var added, walk of 2026-07-12) + decided: cgroup init becomes unconditional-for-attribution; leaves named by sessionId; gateway registers cgroup→session with the helper |
| L2 | fd-metadata fanotify cannot see rename destinations or deleted paths; every atomic-save (vim, syncthing, gateway PUT via `drive/.duet/uploads`) writes a temp name + renames | fanotify spike §gotchas; `runtime/http.ts:208`, `routes/files.ts` | **Resolved** — FID-mode group proven (Q12); production keeps a bounded handle→writer cache to join temp-file writes to their rename destination |
| L3 | Spawn-then-place window: agent-boot files touched before cgroup placement | `process-runner.ts:319-321` | Accepted gap (Example User) |
| L4 | Actor-header injection if the header is whitelisted: `forwardedHeaders` copy client values verbatim | `apps/api/src/gateway/client.ts:349` | Decided rule: synthesize server-side post-copy |
| L5 | API-key id is dropped at the Convex auth boundary — `api-key:<id>` needs it | `domains/apiKeys/api.ts:58` | Decided: thread credential id into the auth payload |
| L6 | Restore is drive-wide `rm -rf` + `rename` (new inodes, mass events, syncthing state replaced under a running daemon) | `vm/archive.ts:280`, `vm/phone-home.ts:63` | Decided: restore = named pipeline state — suppress watcher, emit one `system` restore event, rescan after |
| L7 | Gateway restart loses buffers; orphan sweep SIGKILLs runners | `gateway-update.ts:116`, `runner/orphan-sweep.ts` | Accepted (Example User); side benefit: no live-session reseed problem |
| L8 | Cgroup teardown races final events; crash paths leak leaves | `process-runner.ts:303`, `cgroup.ts:38` | Decided: exit-plus-drain contract; helper GCs stale leaves |
| L9 | Gateway staging writes under `drive/.duet/uploads` look like drive writes | `runtime/http.ts:208` | Decided: prefix-filter `.duet/**`; API routes emit semantic events; gateway-pid watcher events dropped |
| L10 | Syncthing's temp-file protocol is not derivable from this repo (external binary; only `.sync-conflict-` landing names are known) | `sync/conflicts.ts:4` | Builder-confirm: runtime probe against the pinned syncthing version |
| L11 | Two sync-metadata owners drift: `sync-mounts.json` vs syncthing folder config (configure/remove paths don't update both) | `sync/mount-store.ts`, `routes/sync.ts:118,158` | Decided: mount-store is authoritative; reconcile on gateway start |
| L12 | fanotify overflow is silent; helper output on the watched mount self-amplifies | fanotify spike §gotchas | Decided: `FAN_Q_OVERFLOW` + attribution-drop counters are first-class telemetry; sink on `/dev/shm` |
| L13 | Kernel opens ≠ intentional reads (previews, media range requests, listings) | sweep; `preview-pane.tsx:80` | Decided: content reads only (Q7); API GET-file counts, list/stat doesn't |

## Builder must confirm before coding

- ~~FID spike verdict~~ — resolved: single FID/name group, cgroup resolution
  confirmed working in FID mode (20/20 events in the dedicated-cgroup test).
- ~~Bind mount~~ — dropped from the design (Q9): `FAN_MARK_FILESYSTEM` is
  superblock-wide, so prefix filtering does the scoping and no mount changes
  are needed in the VM image.
- Public publish/share GETs go through `serveDriveGet` anonymously — they are
  unattributed reads and therefore dropped (consistent with Q1); confirm no
  product need for a `public` read bucket before v1.
- Backend conventions (from the sweep): internalKey validation on api-called
  mutations, injectable `now`, seq+compound-index ordering for event tables,
  thin public wrappers over domain functions, tests via public function names,
  batch-bounded deletion crons.

## Tweakable build plan (sorted by likelihood you'll tweak, not by order)

1. **Schema + actor-context encoding** — context string format, bucket length
   (6h vs 24h), whether `fileAccess` rollup ships in v1 or is derived.
2. **Helper architecture** — single vs dual fanotify group (pending FID
   spike); NDJSON protocol between helper and gateway.
3. **Files SPA surfaces** — A (list column) + B (preview strip) first; C
   (history drawer with inline reads) and D (activity feed) follow.
4. **API actor forwarding** — header name/shape; api-key id threading through
   the Convex auth payload.
5. Gateway pipeline: flush cadence, restore suppression, staging filters.
6. Cgroup rework: unconditional init, session-named leaves, exit-drain
   teardown. (Mechanical once decided.)
7. VM image: bind mount + helper wiring. (Mechanical.)
8. Query API for programmatic consumers. (Shape follows the SPA needs.)

## Status

The spec has been written from this map (2026-07-12): see
[README.md](README.md) for the slice ladder and the Next Agent Prompt, and
the archived slice contracts in git history (`specs/file-attribution/slices/` before the 2026-07-14 close). On 2026-07-13 the spec absorbed drive
sync — [MAP-SYNC.md](MAP-SYNC.md) is the second binding decision record, the
ladder grew slices 13–22, and slice 01 absorbed MAP-SYNC Q10/Q11 (mirror
actor, size/mtime on write events) before landing. Both maps remain the
binding decision records the spec inherits.
