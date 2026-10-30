# Official Agents — shipped record

**Status: shipped to staging 2026-07-22; all 14 slices (00–13) landed and
merged.** A centralized hub of **official** prebuilt agents, authored by the
Duet team in one **golden workspace** per environment and installable into any
user workspace as a read-only, auto-updating subscription. Distribution is
publish-pull over the public publish grammar — never Syncthing: the golden
workspace folder-publishes its hub; each subscriber's gateway polls
`edge…/<ws>/<pub>/<agent>?zip` with `If-None-Match` against the stat-tree ETag
and re-materializes on change with repair semantics mirroring the Syncthing
read-mode enforcer. Pause ships on both rails (publish-freeze +
share-pause), plus clone-to-own.

The decisions-made-where-the-spec-was-silent ledger is
[`choices.md`](choices.md). The whole-spec review (Codex + orchestrator) ran
before close; both findings were fixed (sync install push carries the desired
projection; resumed/deleted publishes reap their snapshots).

## E2E evidence at close (honest ledger)

Slice 13's staging legs are **built and locally green**
(`packages/test-harness/src/staging-e2e-synthetic`). The **full live
pass was not achieved before close** — staging churned faster than any single
run (each attempt imported newer unproven work from parallel features), and
Example User called the close with local gates standing in. What DID happen live:

- The golden-workspace prerequisite was provisioned on staging: owner account
  `user@example.invalid` created via the admin login-as rail, and
  `DUET_OFFICIAL_HUB_OWNER_EMAIL` synced through the secret topology to
  `vercel:api` (2026-07-22). Before this, the seed endpoint 404'd — the
  "owner knob is a deployment input" requirement is real and now documented in
  `scripts/secret-topology.mjs`.
- The legs stay required in `bun run e2e:staging`, so every subsequent full
  run exercises them; nothing waited on them to merge.

**Recorded open item (user-gated): prod provisioning.** The prod
golden-workspace owner account + env var (same provisioning as staging), and
Example User's editorial review of the 3 provisional seed agents.

## Decision ledger (binding — from the planning walk with Example User)

Distribution: publish-pull over `?zip` + ETag polling (Syncthing rejected:
500-share cap + peer fan-out). One hub publish; per-agent nested zip polling.
Publish serves everything except the floor (`isPublishExcludedDrivePath`:
`.env*`, `.git`, `node_modules`, `.duet-anchor`) — one owner, no hub
carve-outs. Official content is deliberately public. `node_modules` never
ships; deps install on the VM via the apps' existing `installCommand` rail.

Install: target `agents/<name>` at the drive root; collision → typed refusal
with rename prompt (plus an accepted rename-on-collision path, an integration
fixup), never auto-suffix. Install registers rows via `registerAgentImpl`
(`MAX_AGENTS_PER_WORKSPACE` enforced) and reads the golden workspace's `apps`
rows directly from Convex — no file manifest. After install the user lands
back where they were; no auto-opened session.

Read-only is SOFT and eventually-consistent: every poll repairs — upstream
files restored, user edits to upstream paths preserved as conflict-renamed
copies (upstream wins + conflict copy, Syncthing naming), user additions
persist and never sync anywhere. A 304 still repairs from the cached upstream
snapshot. Uninstall = detach (files stay, rows become local). Clone = one-shot
materialization: a `clone_once` subscription row that becomes `detached` after
application — a record, not a live poll. Per-agent memory/logs are already
recipient-local — nothing was built for them.

Pause: publish-freeze (shadow snapshot; ETag freezes; snapshot commits BEFORE
`paused` becomes visible; missing shadow fails closed) and share-pause
(desired-state flag → converger sets Syncthing folder pause; both directions
pause; queued edits flow on resume).

Surfaces: onboarding starters gallery (new users, skippable); Agents opens on
Home, where the official catalog and detail live (description, skills,
CHANGELOG.md "What's new", Install). Clone-to-own remains an API capability,
not a competing gallery action. Drive stays scoped to files and app folders;
it does not summarize agents. Chat-led discovery skipped. The user-facing word
is **"official"**. Updates are visible (badge + changelog; durable
`acknowledgedEtag`).

Golden workspace: real workspace, Aomni-owned, seeded idempotently
(only-if-absent, per env), never idle-retired, entered via an internal-admin
impersonation button (`mintImpersonationKey` behind existing admin gating —
dropdown visibility rejected: it would special-case `listMine`/`assertRole`).
Three provisional seed agents ship with the rails.

No backward compat, no migrations: every schema change is an additive optional
field or new table.

## Architecture (single-owner map)

| Component | Home | Owns |
|---|---|---|
| Official vocabulary | `packages/contract/src/official-agents/` | subscription/catalog/wire/error shapes |
| Conflict naming | `packages/contract/src/sync-conflicts/` | `formatSyncConflictName` (extracted from read-mode-enforcer; both consume) |
| Materializer | `packages/gateway/src/official-agents/materializer.ts` | three-way repair (old upstream × new upstream × local), journaled |
| Puller + store | `packages/gateway/src/official-agents/` | conditional GET, snapshot cache, interval + pull-now, report outbox |
| Subscriptions | `packages/backend/convex/domains/officialAgents/` | install/uninstall/clone/acknowledge, report intake, app-row reseed |
| Hub config | `officialHub` singleton table | the ONE owner of "where is the hub" per env |
| Catalog service | `apps/api/src/routes/official-agents.ts` + service | server-side publish fetch → `OfficialAgentCatalog` (no SPA↔edge CORS) |
| Freeze shadow | `packages/gateway/src/publishes/` + `packages/gateway/src/routes/publish-subtree.ts` | snapshot store; visible-subtree walk shared with zip |
| Share pause | flag → `syncProjection` → `share-converger` | Syncthing folder `paused` |
| Seed content | `packages/official-agents-seed/` | authored agents, deterministic bundle |
| UI | `apps/web/spa/official-agents/` + routes | Agents Home catalog/detail, onboarding gallery, pause switches |

Single-owner invariants: one conflict-name convention; one serving floor; one
visible-subtree walk (zip + freeze snapshot); one catalog parser; one hub-URL
owner; one SPA agent transport (shared with the shipped agents-ui).

## Load-bearing mechanics

- `sameGatewayAppRuntimeConfig` skips reinstall when command metadata is
  unchanged → content-only updates ride `contentGeneration` (the applied
  subscription ETag) on `GatewayAppConfig`; general apps keep `undefined`.
  Backend reseeds app rows from golden rows when a pull report advances the
  applied ETag; the changed config flows to the supervisor which reruns
  `installCommand`.
- The zip ETag is stat-derived (path/size/mtimeNs), not content bytes — the
  golden authoring flow always writes through normal file ops.
- Manifest-loss conservative default: if the puller's cached snapshot is gone,
  the next pull conflict-copies every divergent upstream path rather than
  silently overwriting.
- Zip bounds: 1,000 entries / 512 MiB per archive; the puller surfaces
  `recursive_limit_exceeded` as a typed, visible, non-retryable error.
- Slice 01's kill condition fired during build: the materializer shipped with
  a strengthened quarantine + deferred-reap journal (divergence worth knowing
  before touching it).

## Scope firewalls (still binding)

- Launch wire stays `.strict() { cwd, gatewayModelId }`; `resolveNearestAgent`
  stays the only ranking; runtime eligibility stays projected `agentId`.
- The share-replication driver's identity rule is not bent; only pure helpers
  are reused. `read-mode-enforcer.ts` behavior untouched beyond the naming
  extraction (its test suite is the oracle).
- No fs-permission read-only tricks. No general remote-package installer (the
  puller accepts only URLs derived from `officialHub`). No catalog CMS. No
  second agent roster. No `agent.json` growth. No migrations.

## Dead ends (do not re-walk)

- **Syncthing as the distribution rail** — 500-share cap and peer fan-out
  kill it at hub scale.
- **Golden-workspace visibility via the workspace dropdown** — special-cases
  `listMine`/`assertRole`; the impersonation button costs nothing.
- **File manifests for app registration** — rejected already in the
  agent-drive research; golden `apps` rows are read directly from Convex.
- **`.strict()` schemas on gateway-consumed responses** — the class of brick
  service-proxies' slice 08 fixed; tolerant parsing is the rule.

## Pointers into the code

- Harness legs: `packages/test-harness/src/staging-e2e-synthetic`
  (seed idempotence, catalog, install, repair, pause, clone).
- Golden seed: `packages/backend/convex/domains/internalAdmin/officialHub.ts`
  (`beginSeed` requires the owner account; `completeSeed` pins seed version).
- Everything else: the architecture table above is greppable module-by-module.
