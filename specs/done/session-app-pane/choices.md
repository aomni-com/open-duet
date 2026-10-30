# Choices ledger — session-app-pane (final, consolidated)

Every decision made where the spec was silent or wrong, re-audited against
the shipped code. Grouped by how much they deserve your attention,
least-confident first. Per-pass history lives in git if you ever want the
play-by-play.

## Worth your eyes (product-behavior calls you never explicitly made)

- **A visibility toggle reaches the agent's prompt within ~5 seconds, not
  instantly.** Toggling an app public/private does not push to the gateway
  (only `disabled` pushes, because it must stop/start the process); the
  gateway learns on its next sync poll. ELI5: flip an app to public and an
  agent's "your apps" list can say "private" for up to five more seconds.
  Chosen because a synchronous push would couple the visibility route to
  gateway availability for a cosmetic fact. Revisit only if that window ever
  matters.
- **The cwd endpoint cannot move a session back to the drive root.** A path
  that normalizes to root (e.g. `a/..`) rejects as `outside_drive`; root is
  expressible only at session creation (absent cwd). Agents move *into* app
  folders, so nothing needs this today — but it is an asymmetry an agent
  could someday hit.
- **The mobile `spa-shell-train.png` visual baseline stays red, inherited.**
  Proven identical on a pre-feature tree; it is the known train-playground
  defect from the connected-providers work. Nothing here approved over it;
  it still wants its upstream fix.

## Settled — architecture (each one a correction or invention the spec didn't contain)

- **Strip, not loose, on `GatewayAppConfigSchema`.** The spec's sacred
  contract said `.loose()`; a pinned security test proved reports must
  *strip* unknown fields so app credential fields can never echo through
  reconciliation. Skew safety = drop unknowns + optional-forever fields. The
  spec was corrected, not the gate.
- **Scope drift heals server-side.** Adding `sessions` to `vmModelScopes`
  would have left live VMs unauthorized for up to a key lifetime (the VM only
  re-requests credentials near expiry). vm-sync now delivers rotated
  credentials unprompted when the live key's scope set is stale — every
  workspace heals within one 5s poll of deploy.
- **A runner that parks at `ask` after a mid-turn move is retired at answer
  time.** The reuse gate compares the runner's spawn cwd (WeakMap) with the
  canonical envelope cwd; mismatch → kill + checkpoint rehydration under the
  new directory. Corollary: a session in filesystem-fallback keeps
  respawning per answer while the bad path persists — rare, self-describing
  via the durable warning.
- **A lost cwd CAS re-aligns the gateway.** The 409 branch best-effort
  POSTs the row's authoritative cwd back to the gateway; ordinary dispatch
  re-projection remains the backstop.
- **Report dedup is a third comparator that includes prompt metadata** —
  a reconciliation report is the exact acknowledgment of the config it
  echoes, so visibility/URL changes queue one fresh report. The restart and
  backend-acceptance comparators still exclude metadata (the frozen-
  reconciling firewall holds).
- **Foreign workspace keys get 403 `insufficient_scope`, not 404** —
  scope-first, uniform with every sibling session route (spec said 404;
  uniformity won).
- **A broken-anchor app never renders a blank pane.** `AppFrameBody` shows
  the broken-anchor explanation whenever no repair action is supplied; the
  Apps route still owns the repair card.
- **The collapsed pane has a header reopen control** — slice 08 shipped
  collapse as a one-way door (invisible to pixel gates under the 0.5% diff
  tolerance); fixed with an interaction test as the real pin.
- **One desired-apps owner on the gateway.** The runtime-local `desiredApps`
  array was deleted; official-agent refresh and app-credential discovery now
  read `AppSupervisor.desiredConfigs()` (immutable snapshot). Note: the
  supervisor sorts with `localeCompare`; the prompt renderer re-sorts with
  code-point order and must never depend on supervisor ordering.
- **Boot window accepted:** a spawn inside the ≤5s window after gateway
  restart sees an empty app catalog; the prompt self-describes as a
  session-start snapshot with a live-list pointer. Gating spawns on sync was
  rejected.

## Settled — local shape (accepted from implementers, verified in place)

- `appForCwd` equal-depth tie-break: slug lexical min; grouping returns
  `ReadonlyMap`, preserving old web semantics.
- `withPublicAppUrls` strips a stale `canonicalUrl` from private configs
  (enforces "URL iff public" at the seam); an older API omitting
  `workspaceSlug` keeps the last accepted durable value.
- Browser freshness: 1000ms leading-edge coalescing inside
  `useSessionDetail`'s existing SSE effect — no second stream owner.
- Prompt: filename `your-apps.md`; names sanitized to one safe line (empty →
  `App`); atomic UUID-temp write, mode 0600; fallback warning copy
  `The session folder "<from>" is unavailable. Continuing from "<to>".`,
  re-emitted per spawn while the condition persists.
- Typed `AgentSessionCwdError` (`not_found`/`invalid_cwd` + reason) instead
  of message matching; reason spellings are the wire values.
- Mobile viewer is the existing Radix dialog (focus trap/return, Escape,
  reduced-motion); chip truncates to keep a one-row header.
- Journey: bound agent at the seeded `welcome` anchor reusing
  `welcome/hello-app`; garbage probe is a missing descendant, escape probe is
  `welcome/..` expecting `outside_agent_anchor`; 240s/1s poll budget; the
  garbage 422 is asserted by the harness directly, never inferred from model
  prose.
- Test-only fixes: VM-key fixtures mint at real epoch time (the auth
  middleware validates with `Date.now()`); an over-long test workspace slug
  prefix was shortened.

## Addendum (live closeout)

- **Convex validators are a second closed schema on the wire.** The staging
  deploy briefly broke fresh-workspace reconciliation: the vm-sync convex
  args validator lacked the optional `visibility`/`canonicalUrl` fields, so
  every sync from an updated gateway was rejected — heartbeats stopped, apps
  stuck `reconciling`. Fixed + deployed within the session; the fleet
  self-healed in one poll; pinned by a backend test that pushes the exact
  production report shape. Lesson: additive wire fields must be audited in
  BOTH the zod schema and every convex `v.object` that carries them.
- **An idle session page has no refresh rail for external reactivation**
  (pre-existing): `shouldOpenSessionStream` stays closed for a terminal,
  caught-up session, so a prompt delivered via the API while the page is
  open leaves the page stale until user interaction. Surfaced by the
  journey; the journey now opens the page during the move turn (which is
  also the pane's real usage shape). A "reactivation signal" is a future
  spec candidate, not part of this feature.
- **Probe leftover:** one manual debug workspace
  (`seedprobe-1785395060543-s-workspace`) could not be retired — the test
  cleanup rail rightly guards on synthetic `staging-e2e-synthetic*` identities.
  Needs a manual reap; future probes must use the synthetic email shape.

## Post-close ruling (Example User, 2026-07-30)

- **"Terminal means terminal" — ask-parking abolished.** The pre-existing
  warm-parked-runner-at-ask optimization (and this feature's retirement
  machinery layered on it: the spawn-cwd WeakMap gate, setCwd's parked-kill,
  the live-runner disk-guard special case) was deleted wholesale; every
  terminal kills its runner and answers rehydrate from the durable
  checkpoint. Simpler invariant, one spawn per answer as the cost.
