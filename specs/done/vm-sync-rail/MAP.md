# vm-sync-rail — quadrant map (walk completed 2026-07-15)

The map from the explore-unknowns walk. Binding alongside README.md; where
this map records a decision, slices defer to it.

## Known knowns — settled ground

- One 5s `POST /v1/vm/sync`; old heartbeat/anchors endpoints removed same
  release; fleet reprovisioned (owner, interview).
- Gateway version derived from the api's baked release — verified real at
  runtime: `scripts/vercel-bundle.mjs:35-42` ships `dist/gateway-release`
  inside the deployed function (`DUET_GATEWAY_RELEASE_DIR`); artifacts 790KB +
  670KB, far under serving limits.
- Agent/duetfs versions: api env; one Convex `vmUpdateControl` kill switch,
  missing row = not paused (reversed 2026-07-24, see README); cached read + throttled write (~1 persist/VM/min).
- Bun owns the CLI install tree (owner, 2026-07-15) — replaces the
  npm-root discovery that made the agent rail a silent no-op since launch.
- Incident mechanics (half-install → EPIPE → first-beat marker → start-limit
  death) verified and encoded as regression tests in slices 01/04/05.
- **Both fleets are empty**: staging workspaces all deleted 2026-07-15; prod
  Convex has zero workspaces and no pins. No blackout/freeze machinery needed;
  prod rollout is a greenfield ordered deploy.

## Known unknowns — decision ledger

| # | Question | Closed by | Answer |
|---|---|---|---|
| 1 | Response schema evolution | owner | Requests strict, responses tolerant, **no protocol version**. Encoded in slice 02 and in the code-review skill (rule 21) so it never recurs on internal APIs. |
| 2 | Reserve shared-apps seam in response? | owner+territory | No reserved field; tolerant responses make convergence payload additive. `specs/shared-apps/MAP.md` landmine #1 depends on this rail; build order: vm-sync-rail first. |
| 3 | duetfs npm publication (R1) | territory | Published under owner's account (v0.0.1, 2026-07-05); repo at 0.1.0. "Publish current version" is a slice-09 rollout step, not a blocker. |
| 4 | Prod fleet state | territory | Empty (no workspaces, no pins). |
| 5 | Bun staged installs | territory (probe) | `BUN_INSTALL` custom roots, exact versions, downgrades all work. |
| 6 | Convex cache at 5s (R2) | territory (measured) | Same pattern as `listForVm`: 92% query-cache hits at 5s per-VM args. |
| 7 | Health thresholds (R3) | territory (incident journal) | 60s uptime + 3 syncs; >30x margin over observed 1–2s crash cycles; slice 05 drill re-measures. |
| 8 | Bootstrap auth (R4) | territory | VM token in `~/.duet` readable without release code; headers from unit env; boot-storm moot at fleet size 0. |

Nothing OPEN.

## Unknown knowns — extracted taste & context

- **Telemetry rides the poll**: cpu/mem/disk in the sync request, latest
  snapshot stored on the workspace row at persist cadence (~1/min); no
  metrics-history table (slices 02/03).
- **3am failure taste: auto-rollback.** The morning-after end state is fleet
  on the previous release and holding — never parked awaiting a human
  (slice 05 aggressive rollback + quarantine; drill in slice 09).
- **Done-bar**: `e2e:staging` green + two drills recorded: (a) bad release →
  auto-recovery by morning; (b) manually installed OUTDATED agent/duetfs get
  converged back up by sync — the rail corrects manual drift, not just
  planned releases (slice 09 step 8).
- **Internal-API taste (generalized)**: we control both ends and deploy
  everything — no version/compat machinery on internal APIs, ever. Now
  code-review rule 21.

## Unknown unknowns — landmine cards

1. 🟢 **Release derivation is end to end**: the API deployment announces its
   own baked gateway manifest, and the staging-e2e-synthetic gate compares that version
   with the workspace's reported gateway version.
2. 🟡 **Activity-file format has no in-place migration** — generation latch
   ships only via reprovision (README warning; slice 07).
3. 🟡 **Projection inherits `listForVm`'s `.collect()`**
   (`domains/anchors/model.ts:343`) — justified-bounded today; slice 03 must
   not widen the read set behind that comment.
4. 🟢 Release-inside-lambda packaging verified (see known knowns).
5. 🟢 Agent-input drain stays at ~60s by design; faster wake-ups ride the
   tolerant response later if wanted.
6. 🟢 No external heartbeat consumers beyond built artifacts; staging-e2e-synthetic CI
   is manual-dispatch only — no cutover collision.

## Facts the builder confirms before coding (not footnotes)

- `bun add -g` behavior on the *VM image's* bun version matches the local
  probe (slice 00).
- `StartLimitIntervalSec=0` honored on the exe.dev distro's systemd (slice 00).
- Incident-journal thresholds still hold on real VM boot timing (slice 05 drill).

## Tweakable plan

Judgment calls most likely to move (alternatives recorded in slices):
1. Health thresholds 60s/3-syncs (slice 05) — re-measured by drill.
2. Sync-degrades-vs-503 on unreadable manifest (slice 06; alternative noted).
3. Telemetry field set (slice 02) — trivially extensible, tolerant responses.

Mechanical work, trusted as specced: contract module, Convex domain, route
composition, loop port, deletions table, rollout order (slices 02/03/06/07/09).

## Implementation kickoff (copy-paste)

> Implement specs/vm-sync-rail starting at slices/00-proofs.md and
> slices/01-helper-containment.md (independent; 01 can land today). Follow
> the repo write-tests TDD rule, keep MAP.md decisions binding, update the
> README Next Agent Prompt after each slice, and stop before slice 09's prod
> cutover for owner sign-off.
