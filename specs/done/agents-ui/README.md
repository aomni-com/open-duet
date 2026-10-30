# Agents UI — rationale record

Shipped 2026-07-22 on `staging`. The headless [`agents`](../agents/README.md)
feature gave Duet agent rows, session attribution, and CRUD; this spec made
them reachable: the product shell's single static "Duet" card is now an **agent
roster** — one card per agent, each owning its own apps, sessions, and actions
— plus an agent detail canvas, an agent picker on session create, jobs
attribution, and Duet's own ability to link the user back to an agent it just
created.

**Companion records:** [`MAP.md`](MAP.md) is the planning quadrant walk (D1–D22
decisions, L1–L9 landmines) — kept verbatim as provenance; where this record is
silent, the map holds the original reasoning. [`choices.md`](choices.md) is the
consolidated ledger of every decision made where the spec was silent, grouped
by verdict — the review surface for what was decided without the user.

## The reason it works this way

- **Attribution flows through `cwd`, never an `agentId` on the wire.** A
  session belongs to the nearest agent ancestor of its working directory,
  resolved server-side by `resolveNearestAgent` in `@repo/contract`. The web
  app sends `cwd: anchorPath` (or nothing, for the default agent) and the
  launch wire stays `.strict()`. This keeps attribution the backend's single
  decision — the client cannot claim an agent it didn't launch under, and the
  rule has exactly one owner shared by Convex attribution, the gateway runtime,
  and client-side app grouping (via the `agentResolutionCandidate` adapter).
- **The agent dimension is a parameter, not a parallel system.** Session and
  job lists accept `agentId?: 'root' | <id>` end-to-end: two agent-variant
  Convex indexes, a sixth `search_sessions` filter field, and one `agentScope()`
  helper inside the existing access-path branch tree in
  `packages/backend/convex/domains/agentSessions/queries.ts`. No second query
  function exists. The unsupported `agentId` + `archived:'include'` combination
  is rejected at the contract (400) *and* re-thrown in the impl, because a
  silent fallback to an unscoped scan would be a data leak wearing a filter's
  clothes.
- **Per-card queries, not client-side grouping.** Each roster card runs its own
  infinite query under the standard session-list cache key. This was chosen
  over grouping one big list because grouping yields half-empty cards and
  counts that are really "N loaded" (MAP D2). The active card pages; preview
  cards fetch `previewLimit + 1` as count-free lookahead ("Show all" carries no
  number — Convex pagination has no totals, D18).
- **The cache matcher learned the dimension in the same change as the key.**
  `sessionMatchesStructuralFilters` folds `summary.agent?.id ?? ROOT_AGENT_SCOPE`
  exactly as the backend narrows `'root'` to `eq(agentId, undefined)`. A filter
  dimension the matcher doesn't know mis-files every optimistic mutation into
  every card, invisibly (L7 — the highest-risk defect in the plan, found only
  by a drafting fan-out). **Rule: a dimension in the key is a dimension in the
  matcher, always, same change.**
- **Deleting an agent terminalizes its work — in two halves.** The Convex sweep
  (`continueSessionTerminalizationForScope`, one mechanism parameterized by
  candidate source / guard / reason, shared with workspace pause) marks state;
  the gateway's `discardAgent(agentAnchorId)` kills the actual runners via the
  session-delete `discard()` machinery, gateway-first and fail-closed (502
  deletes nothing when the gateway is unreachable). A Convex-only sweep would
  strand live processes relaying into sessions the database already calls
  interrupted. Deletion is cheap to make terminal because it is not
  destruction: anchors orphan and re-registering the same folder adopts the
  same `anchorId`, so per-agent memory resurrects on recreate.
- **Role and skills are derived from the agent's own files** (`AGENTS.md`
  first prose line; `.agents/skills/` listing), fetched lazily per card with
  silent degradation — a missing file is a normal state, never an error banner,
  and never changes the health pill (D10, SE-1).
- **Duet links back with a root-relative URL** (`/w/<slug>/agents/<slug>`)
  because the sandbox knows `DUET_API_URL` but no web-app origin; the SPA
  intercepts same-origin links through one pure classifier. The alternative —
  threading a `DUET_APP_URL` through gateway, provisioning, and secret topology
  just to build a string — was rejected (D7).

## Invariants (violating any of these silently breaks the feature)

- One nearest-agent rule: `resolveNearestAgent` + `agentResolutionCandidate`
  (`packages/contract/src/agents/index.ts`); never a third open-coded copy.
- One access-path chooser: the branch tree in `agentSessions/queries.ts`; the
  agent dimension is a parameter of it.
- One terminalization mechanism: `continueSessionTerminalizationForScope`
  (`agentSessions/events.ts`); workspace pause must keep writing
  `workspace_paused` under its servicing guard.
- One status table: `apps/web/spa/status/entity-status.ts`, per-entity
  projectors. `AppDisplayStatus = Exclude<DisplayStatus,'shared'>` is the type
  keeping apps from ever projecting `shared` (apps carry `sourceShareId` too;
  repainting replica app cards was never decided).
- Key ↔ matcher pairing: `SessionListKeyFilters.agentId` ↔
  `sessionMatchesStructuralFilters` (`apps/web/spa/sessions/session-cache.ts`).
- The rail is props-only (`apps/web/spa/drive/agent-roster-rail.tsx`); queries
  live in `WiredRosterCard` (`agent-roster.tsx`); the cross-surface card/menu
  vocabulary lives in `agent-roster-types.ts`. Its order is one explicit
  navigation contract: Home, Duet, registered agents, then the conversational
  New agent entry. The rail has no search mode or duplicate section header.
- Menus have three shapes (`default`/`agent`/`replica`, table
  `AGENT_MENU_ITEMS`) because replicas are read-only at the origin (L8): a
  two-shape menu renders rename/delete buttons that always 403.
- Delete is never optimistic (fail-closed gateway leg); rename is optimistic
  with rollback. The API route asserts mutability *before* the teardown leg.
- One link classifier: `sessionLinkTarget` (`apps/web/spa/sessions/
  session-link.ts`), consumed by BOTH markdown call sites
  (`ordered-agent-parts.tsx` and `session-message.tsx`) — `Markdown` in
  `@repo/ui` preventDefaults every anchor once a handler exists, so a handler
  that only knows `/w/...` kills every external link an agent posts (L4).
- `@repo/ui` imports no product service: the ComposeBar agent picker is an
  opaque capability (`agent?: ComposeBarPicker<AgentId>`), `AgentId` a consumer
  generic.
- No GET-agent-by-slug: the list is the source; detail resolves from the cached
  roster, with a one-shot ref-guarded refetch for unknown slugs (D8).
- Per-agent profile reads degrade silently and independently
  (`apps/web/spa/drive/agent-profile.ts`).
- The web app never sends `agentId` on session create. Ever.

## Pointers into the code

Contract: `packages/contract/src/sessions/index.ts` (`ROOT_AGENT_SCOPE`,
list-query schemas + D19 refine), `packages/contract/src/agents/index.ts`
(`agentIsLaunchable`, `agentResolutionCandidate`). Backend:
`packages/backend/convex/schema.ts` (agent-variant indexes),
`domains/agentSessions/{queries,events}.ts`, `domains/agents/model.ts`
(delete → sweep scheduling). Gateway: `agent-sessions/coordinator.ts`
(`discardAgent`). API: `apps/api/src/routes/agents.ts` (fail-closed delete).
Web: `apps/web/spa/drive/agent-roster*.{ts,tsx}`, `spa/status/entity-status.ts`,
`spa/agents/{agent-actions.tsx,agent-mutations.ts,agent-display.ts}`,
`spa/routes/agents.tsx` + `spa/routes/agents/*` (detail canvas, freshness),
`spa/sessions/{session-agent-picker.ts,session-link.ts,session-cache.ts}`,
`spa/jobs/*` (attribution chip + filter). Skill:
`packages/skills-registry/skills/manage-agents/SKILL.md` (emits the link).
Staging journey: `packages/test-harness/src/staging-e2e-synthetic`
(`agent-lifecycle` leg). Tests pinning the sharp edges:
`packages/backend/src/agent-sessions.test.ts` (L2/L1 probes, D19, sweep),
`apps/web/spa/sessions/session-data.test.ts` (mis-filing regressions),
`apps/web/spa/sessions/session-link.test.ts` (both link branches),
`apps/api/src/index.test.ts` (fail-closed + replica-403-before-teardown).

## Divergences from the plan (the part worth reading)

- **The map undercounted reality twice**: the playground rename was 64 goto
  strings / 97 baselines (map said 57/95), and L1's "both non-search branches"
  was three branches over four indexes. Probe-first planning caught both.
- **The later shell consolidation made each destination local to its owner.**
  Official agents became Agents Home; Train moved onto the Duet card; the
  single Duet drive action became a direct icon; and session creation moved
  above Duet's session titles. The former rail header and cross-agent search
  disappeared because neither represented a destination in this model.
- **A job-session cannot appear in the rail's session list** — the session
  list filters `jobView === undefined` by design. The staging journey
  originally asserted the opposite and failed against correct product
  behavior; it now proves the scoped list with a plain session AND pins that
  the job does not leak in.
- **The staging e2e must run after the staging push, not before** — it
  exercises deployed services; a pre-push run failed exactly where the deployed
  backend predated the feature.
- **Two neighbouring defects were found and fixed en route**: the publish-viewer
  shipped reading `DUET_WEB_ORIGIN`, which no environment provisioned — every
  bare publish URL 502'd `viewer_origin_unavailable` and aborted the e2e
  harness before this spec's legs; fixed with a typed per-env default in
  `apps/edge/src/config.ts` (per the repo's config convention; R4 forbids
  deriving from the inbound Host). And the spa-shell playground never pinned
  the injectable attribution clock, so its relative-time baselines rotted
  daily; `FIXTURE_NOW` now freezes it.
- **`uniqueSlug` in the API test harness overflowed `MAX_SLUG_LENGTH`** as the
  suite grew — a latent bug that made three tests order-sensitive; and the
  agent-delete route surfaced a real bug where a post-deletion reconcile
  failure 502'd an already-committed deletion unretryably on paused
  workspaces (now best-effort).

## Verification state at close

All local gates green at `f85eae1b` on staging: full unit/boundary suites,
repo-wide types/lint, serial `apps/api` suite, and the Docker visual gate
including the first-ever baselines for this surface (roster, detail, menus,
search — desktop, mobile, Spanish). Staging e2e evidence: five instrumented
runs proved hosts→ledger, publish-control-plane, product-api, and
agent-continuity green against deployed staging, plus the lifecycle journey's
register/roster/attribution legs; the **full green run of the `agent-lifecycle`
leg (with the rail-list fix and the healed publish viewer) was deliberately
deferred by the user on 2026-07-22** — run `bun run e2e:staging` to discharge
it; the journey and its reachability-gated VM runner-death probe are committed
and unit-covered.

## Visual provenance

The roster is a **port with sign-off**, not an invention: the reference is the
pinned chat-app `installed-agents-sidebar.tsx` (revision recorded in
`specs/drive-shell-port/assets/01-reference/README.md`) and the capture set
`specs/drive-shell-port/assets/03-agents/*.png` — the surface the original
shell port deliberately omitted ("no installed-agent entity") and left a
tripwire for; this spec discharged it, and the cutover report's OMITTED rows now
read `SHIPPED (agents-ui)`. Decision evidence kept in [`assets/`](assets/):
`decision-limit-4.png` (why preview limit is 3 — 4 pushes the third card off
the 20rem fold), `decision-tint-flat.png` (why the default card keeps the brand
tint — flat erases the "this is your default" cue), `roster-spanish.png`
(SE-5 locale gate).
