# Shared apps propagation — rationale record

**Status: shipped to staging 2026-07-15.** Walked and built the same day. This
is now a rationale record: the decision ledger below is the *why* for each
choice (the most valuable thing to keep — it's what a reader would otherwise
re-derive), and the pointers section maps into the code that is the source of
truth for *how*.

## What shipped

Accepting a folder share materializes the origin's apps as **real `apps` rows
in the recipient's workspace** (tagged `sourceShareId`/`sourceAppId`), running
on the recipient's own VM. Every origin-side change — register, update, delete,
move an app out of or back into the shared tree — runs one reconciliation
(`reconcileReplicasForOriginApp`, `packages/backend/convex/domains/apps/replication.ts`):
a replica exists iff the origin app's path is inside an active share root. No
event-pair special cases. Replica run-configs reach recipient VMs on the
vm-sync-rail poll (an optional `apps` field on `VmSyncResponse`), so
convergence needs no push; the inline api push is best-effort acceleration.

## Invariants that must keep holding

- **Convergence rule, not event handlers** (ledger #15). The desired replica
  set is recomputed from active shares + path membership on every origin
  mutation; inserts/patches/deletes converge to it. Adding a new origin-side
  event means calling the one reconciler, never writing a new special case.
- **Ports are per-workspace and never propagate.** The origin's port is
  meaningless in the recipient VM; replicas get a freshly allocated port from
  the reserved range (41000–41999). `$PORT` is injected at spawn.
- **Read replicas are read-only; disable is durable and keeps the row.** A
  disabled replica is skipped by fan-out but survives origin updates; only
  revoke (or origin delete) removes it. Deleting the row would let fan-out
  re-seed it.
- **Read-mode enforcement preserves viewer-local additions.** Folder-wide
  Syncthing revert is forbidden — the v2.1.2 probe proved it deletes local
  additions and conflict copies. Enforcement is targeted repair only
  (`sync/read-mode-enforcer.ts`); evidence in
  [`assets/read-mode-proof.md`](assets/read-mode-proof.md).
- **Share default-ignore (ledger #14) shipped.**
  `DEFAULT_SHARE_IGNORE_PATTERNS = ['**/.git', '(?d)**/node_modules']` — `.env`
  now **syncs** on shares (secrets are shareable by intent); `node_modules`/`.git`
  no longer sync. The shared git/deps verdict has one home in
  `packages/contract/src/sync-ignore/` (composed by both the share and mirror
  defaults). The default is a deliberately-loose, unremovable floor: it lists
  ONLY patterns that technically break a share (git corruption, wrong-arch
  node_modules), so a sharer cannot opt into a broken share. A sharer's
  `ignorePatterns` **ADD** to the floor (`shareIgnorePatterns`, the one owner of
  the merge) — they can exclude more (e.g. `.env`), never less. That override is
  exposed on the public API (`CreateShareRequestSchema`/`ReshareRequestSchema`),
  so a folder's `.env` can be excluded per-share without any UI. The only
  deferred guardrail (Example User: skip the UI) is the share-UI *warning* that a folder
  contains `.env`. Serving `.env` over HTTP stays blocked at edge and gateway
  regardless — syncing and serving are separate policies.

## Pointers into the code

| Concern | Owner |
|---|---|
| Convergence rule + membership/translation seam | `packages/backend/convex/domains/apps/replication.ts` |
| Replica seeding / revoke cleanup / durable disable | `domains/apps/model.ts`, `domains/shares/model.ts` |
| Port auto-assign + `$PORT` + cross-serve fix | `domains/apps/model.ts`, `packages/gateway/src/routes/apps.ts` |
| `installCommand` | same apps model + gateway app route |
| Read-mode receive-only enforcement | `packages/gateway/src/sync/read-mode-enforcer.ts`, `sync/mounts.ts` |
| Apps over the sync poll | `packages/contract/src/vm/` (`apps` field), `apps/api/src/routes/vm.ts`, gateway sync sink |

Hard dependency: replica convergence rides the
[vm-sync-rail](../vm-sync-rail/README.md) 5s poll.

---

## Build ledger (the decisions and their why)
- [x] Slice 1 — port auto-assign (41000–41999) + `$PORT` injection +
      cross-serve fix (landed on staging; explicit ports validated outside
      the range, unique per workspace; supervisor proxies only to
      port-claimed, ownership-verified processes)
- [x] Slice 2 — `installCommand` (landed: runs to completion via `bash -c`
      with cwd+`$PORT` before first spawn, re-runs on config change, 10-min
      timeout, failure ⇒ `reconcile_failed` + no spawn + backoff retry;
      register replaces, update patches; no null-clearing — re-register
      without it clears)
- [x] Slice 3 — replica seeding on accept + revoke cleanup (landed:
      `isAppPathWithinShareRoot`/`translateAppPathToShareMount` in
      `domains/apps/replication.ts` are the convergence-rule seam slice 4
      reuses; reshare chains seed from origin; mount collisions rejected
      against shares AND anchors before any writes; durable disable via
      `POST /v1/ws/:ws/apps/:slug/disabled`; replica update/delete rejected
      until slice 6)
- [x] Slice 4a — origin-mutation fan-out (landed: one
      `reconcileReplicasForOriginApp` in `domains/apps/replication.ts` called
      from register/update/delete/restore/anchor-rename/break/reanchor;
      recipient anchor breaks delete the replica; api fires best-effort
      recipient pushes, concurrency 8, 1s budget)
- [x] Slice 4b — replica convergence over the vm-sync poll (landed:
      `VmSyncResponse.apps?: GatewayAppConfig[]` — absent = no statement,
      `[]` = stop everything; projection shares `runConfigForWorkspaceImpl`
      with the push path; sink feeds the AppSupervisor once per tick; app
      failures never block the tick)

- [x] Slice 5 — read-mode receive-only mounts (landed: sendonly↔receiveonly
      pairing; targeted repair via `LocalIndexUpdated` + `db/file`
      classification in `sync/read-mode-enforcer.ts` — folder-wide revert
      REJECTED because the v2.1.2 probe proved it deletes viewer additions
      and conflict copies (evidence: `assets/read-mode-proof.md`); viewer
      modifications become `.sync-conflict-*` then creator version restored;
      chmod-0555 removed, legacy mounts migrated writable at boot)
- [x] Slice 6 — write-mode bidirectional config (landed: full-write chain required, command/installCommand propagate via the one convergence rule, port stays local, slug edits rejected, failed reconciliation rolls back through the same rule)
Slices 3–4 converge via the vm-sync-rail poll (its slices 00–08 are all
landed; only the 09 staging cutover remains, paused on the npm publish).

Feature: when a folder share is accepted, the apps in it auto-register in the
recipient's workspace (running on the recipient's own VM); origin app changes
(add / modify / delete) propagate to all recipients through the reshare tree.

---

## Known knowns — settled ground

- Workspace = VM, 1:1. Apps are per-workspace rows (`packages/backend/convex/schema.ts:313`),
  run by the owning workspace's VM via `runConfigForWorkspace`
  (`convex/domains/apps/model.ts:297`); edge always routes to the owning
  workspace's VM (`resolveForEdge`, `apps/model.ts:324`). URL shape:
  `<appSlug>--<workspaceSlug>.<domain>` (`packages/gateway/src/routes/apps.ts:310`).
- Shares sync files via Syncthing over sync-tunnel. Share row = share-root
  anchor in origin workspace + recipient-chosen `mountPath`
  (`schema.ts:344`); reshare chains capped at 500 direct children; revoke
  cascades (`convex/domains/shares/model.ts:86,316`).
- Apps hang off anchors (kind `app`); slug and anchor path are each unique
  per workspace (`apps/model.ts:403`, `anchors/model.ts:420`).
- Today there is **zero linkage** between shares and apps, **no install
  step** (gateway spawns `command` directly, `gateway/routes/apps.ts:139`),
  the **port is declarative** (nothing injects/enforces it), and app config
  reaches the VM **only by synchronous API push** (`pushAppsReconcile`,
  `apps/api/src/gateway/client.ts:128`) — no poll fallback exists yet.

## Known unknowns — decision ledger

| # | Question | Decision | Closed by |
|---|----------|----------|-----------|
| 1 | Propagation mechanism | **Materialized replicas**: real `apps` rows in recipient workspace tagged `sourceShareId`/`sourceAppId`; origin mutations fan out through the reshare tree | Example User |
| 2 | Slug collision | Keep origin slug; auto-suffix on collision (`web` → `web-2`). Suffix is stable once assigned | Example User |
| 3 | Port collision | **Product-wide change**: `port` becomes optional in the API; absent = **Convex allocates at registration** from a reserved range (e.g. 41000–41999), stores it on the row, and the API response returns the concrete port so the calling agent knows it. Gateway injects `$PORT`. Explicit `port` remains a first-class override, validated outside the reserved range + unique per workspace (which also closes the cross-serve bug at the source) | Example User |
| 4 | Apps on read shares | Propagate and run on **both** modes ("viewers can run any apps") | Example User (product spec) |
| 5 | Read-mode enforcement | Syncthing **receive-only + auto-revert** (create-yes / modify-no / creator-wins); replaces the chmod-0555 mount (`gateway/src/sync/mounts.ts:48`) | Example User |
| 6 | Install step | New optional **`installCommand`** on apps; propagates like `command`; gateway runs it to completion before first spawn and re-runs on change (e.g. `bun install`) | Example User |
| 7 | Replica lifecycle | **Auto-start everything** on accept | Example User |
| 8 | Recipient control | Read shares: replicas read-only — stop/disable only; **disable is durable** (origin updates never resurrect; flag on the row, not deletion) | Example User |
| 9 | Write-mode config | **Bidirectional** like files: recipient app-config edits flow back to origin and out to other recipients (echo suppression + last-write-wins by `updatedAt`) | Example User |
| 10 | Clobbered viewer file (spec's `[?]`) | Keep as `.sync-conflict` copy (Syncthing default) | Example User |
| 11 | Consent for running creator code | **No disclosure** — accept silently registers and runs the apps. Risk knowingly accepted (see landmine 2) | Example User |
| 12 | Revoke | Replicas hard-deleted through the reshare cascade | decided + informed |
| 13 | Visibility | Replicas never inherit `public`; always land as `folder` | decided + informed |
| 14 | Default ignores | **SHIPPED (additive).** Share default is `['**/.git', '(?d)**/node_modules']` — aligned with the mirror via `sync-ignore/` (write shares put two writers on `.git`; read-mode viewers' git operations would fight the revert loop; node_modules is wrong-arch). `.env*` is deliberately absent: shares treat `.env` as normal files — sometimes the user *wants* to share secrets (and synced env vars make shared apps run). The default is an **unremovable floor** of only-things-that-break; a sharer's `ignorePatterns` (public on create/reshare) **add** to it (`shareIgnorePatterns`), so they can exclude more (e.g. `.env`) but never opt into a broken share. Mirror already syncs `.env`. Deferred (Example User: skip the UI): only the share-UI *warning* that a folder contains `.env` | Example User |
| 15 | Anchor path changes | Fan-out is a **convergence rule, not event-pair logic**: for every (origin app × active share), a replica exists iff the app's path is inside the share root. Every origin-side change — register, update, delete, reanchor in either direction — runs the same reconciliation, so moving an app out of the shared folder deletes the replica (explicit unshare) and moving it back recreates it, with no special cases. Consequences accepted: a recreated replica is a fresh row (a prior recipient disable does not survive the out-and-back round trip, and the slug suffix is re-assigned by the normal collision rule). Path translation happens only at replica (re)creation; afterwards replica anchors follow the recipient VM's own rename detection (`applyRename`, `anchors/model.ts:111`); a replica whose anchor breaks on the recipient (folder vanished from the mount) is deleted, and broken-state recovery (`reanchor`) remains for origin-owned apps only | Example User |

## Unknown knowns — extracted context

- **The share-mode product spec** (from Example User, previously unwritten): read =
  viewer chats with agent, agent/apps may create files but not modify/delete
  creator files, creator updates auto-push and overwrite, viewers run all
  apps; write = full co-development. This reshaped read-mode entirely — the
  built chmod-0555 mount contradicts it.
- **Viewers are mixed** technical/non-technical → replicas must work with
  zero recipient intervention in the happy path.
- **Fan-out scale: tens to low hundreds** per share → inline Convex fan-out
  per mutation is plausible; convergence (waking recipient VMs) is the hard
  part, not row writes.
- **`installCommand` was latent**: extracted when the walkthrough's fake
  "install failed" row prompted "the moment the app is shared, it should
  auto-run the install command."
- Done = **map only**; implementation is a later, separate task.

## Unknown unknowns — landmine cards

1. **No convergence rail** (worst). Reconcile is push-only from the API;
   gateway never polls; suspended/offline recipient VMs stay stale forever.
   → **Hard dependency on the vm-sync-rail spec** (unified 5s VM poll,
   `specs/vm-sync-rail/`): replicas converge on every poll; API pushes
   remain best-effort acceleration. Build order matters.
2. **Sharing = RCE on the viewer's VM.** Accept auto-runs creator-supplied
   `installCommand`/`command` via `bash -c` with full drive access, and the
   origin can silently change commands afterward. Decision: **no
   disclosure** (ledger #11) — risk accepted; revisit if stranger-to-stranger
   sharing becomes a thing.
3. **`node_modules`/`.git` no longer sync on shares** — closed by ledger #14
   (shipped): both are in the unremovable share default-ignore floor.
4. **Anchor-rename double-handling** — closed by ledger #15. Corollary:
   origin moving an app outside the share root is an explicit unshare —
   the replica app is **deleted** (never left broken or running stale files).
5. **Accept-time mount collisions unguarded**: `assertMountDoesNotNest`
   (`shares/model.ts:353`) checks only other shares; a `mountPath` colliding
   with existing anchors or a non-empty dir would crash replica seeding
   mid-way. Fix folded in: accept rejects such mount paths.
6. **Durable disable requires keeping the row** (else fan-out re-seeds):
   `disabledAt`/`disabledByUserId` on replicas; fan-out skips disabled;
   revoke still hard-deletes.
7. **Pre-existing cross-serve port bug**: two same-port apps in one
   workspace → loser's URL silently proxies the winner's process
   (`gateway/routes/apps.ts:228,179`). Fix folded in: supervisor refuses to
   proxy to ports it didn't bind.

**Sharp edges (aware, no action):** origin slug rename re-suffixes replicas
(recipient URL churn); write-mode bidirectional config needs echo
suppression through the reshare tree. On secrets: **`.env` propagates on
shares** (ledger #14 shipped) — env-dependent shared apps run on recipients,
and combined with silent code execution (ledger #11), accepting a share both
runs creator code and, on write shares, syncs the viewer's local `.env`
additions back to the origin. A sharer who does not want a folder's `.env`
shared passes `ignorePatterns` at create/reshare (it adds to the floor).
Serving `.env` over HTTP stays blocked at the edge and gateway
(`isEnvLikeDrivePath`) regardless — syncing and serving are separate policies.

## Contract deltas (the seam, summarized)

```
apps: defineTable({
  ...existing,
  port: v.optional(v.number()),          // absent = auto-assign, $PORT injected
  installCommand: v.optional(v.string()),// runs before first spawn + on change
  sourceShareId: v.optional(v.id('shares')),  // set = replica
  sourceAppId: v.optional(v.id('apps')),
  disabledAt: v.optional(v.number()),         // durable recipient opt-out
  disabledByUserId: v.optional(v.id('users')),
})
  .index('by_source_app', ['sourceAppId'])     // origin-mutation fan-out
  .index('by_source_share', ['sourceShareId']) // revoke cleanup
```

- `registerApp` / `updateApp` / `deleteApp` (origin): after the local write,
  fan out insert/patch/delete to replicas through active shares whose root
  contains the app path (transitively via reshare tree; skip disabled).
- `acceptShare`: seed replicas for existing apps under the root (re-rooted
  at `mountPath`, slug suffixed on collision); reject colliding mount paths.
- `revokeShare`: cascade also deletes each revoked share's replicas.
- Write-mode replica config edits: propagate up to origin and back out
  (echo-suppressed, LWW).
- Gateway apps: free-port allocation + `$PORT` injection; `installCommand`
  phase before spawn; never proxy to a port the supervisor didn't bind.
- Gateway sync mounts: read mode → Syncthing receive-only + auto-revert
  (drop chmod 0555); write mode unchanged.
- Edge / `resolveForEdge`: **no change** — replicas resolve like any app.

## Builder must confirm before coding

- [x] ~~Syncthing receive-only + revert configurable~~ — confirmed 2026-07-15:
      image pins Syncthing v2.1.2 (`packages/vm-image/Dockerfile:86`), the
      gateway already sets folder `type` via config
      (`gateway/src/sync/reconcile.ts:92`), and `receiveonly` + REST
      `db/revert` are stable since Syncthing 1.x.
- [x] ~~Convex mutation limits vs ~200 replica writes~~ — closed 2026-07-15
      by arithmetic: Convex caps a mutation at 4096 document writes / 8 MiB;
      the fan-out scale decision (tens to low hundreds per share) writes
      ≤ ~200 small app rows + anchors per mutation, an order of magnitude
      under both caps. No batching needed at this scale.
- [ ] vm-sync-rail slice status at build time (landmine 1 dependency).
- [x] ~~`$PORT` auto-allocation strategy~~ — resolved (ledger #3): Convex
      allocates at registration, stored on row, API returns concrete port,
      explicit override validated outside the reserved range.
- [x] ~~`pushAppsReconcile` per-recipient vs queueing~~ — resolved: recipient
      VMs converge via the vm-sync-rail poll; the inline push stays only for
      the origin's own VM as instant feedback. No per-recipient push loop.

## Tweakable plan (sorted by likelihood of tweaking, not execution order)

1. **Write-mode bidirectional config** — most likely to change; could ship
   origin→recipient-only first and add the reverse path later.
2. **Read-mode receive-only enforcement** — hinges on the Syncthing
   capability check above; fallback designs exist (files-only chmod,
   overlay) but were rejected for now.
3. **Slug suffix details** — stability rules on origin rename.
4. *Mechanical (trusted)*: schema fields + indexes, seed/fan-out/revoke
   plumbing, `$PORT` injection, install phase, `node_modules` ignore
   default, mount-collision guard, cross-serve fix.

## Implementation prompt (paste when ready to build)

> Implement shared-apps propagation per `specs/shared-apps/MAP.md` (binding).
> Confirm the "builder must confirm" checklist first — especially the
> vm-sync-rail dependency and Syncthing receive-only capability. Start from
> the contract deltas; write-tests-first per AGENTS.md. Ship in slices:
> (1) port auto-assign + `$PORT` + cross-serve fix, (2) `installCommand`,
> (3) replica seeding on accept + revoke cleanup, (4) origin-mutation
> fan-out, (5) read-mode receive-only mounts, (6) write-mode bidirectional
> config.
