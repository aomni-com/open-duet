# Session App Pane — Quadrant Map

Walked 2026-07-30 with Example User. **Binding input for `write-spec`: every decision
below is a given, not a discussion to reopen.**

> **SUPERSEDED IN PART BY THE PLAN.** `README.md` beside this file is the
> build ladder and is authoritative for *how* the feature is built; a fresh
> agent should read the README first. This map stays authoritative for *what
> was decided and why*, with these corrections made during spec drafting
> (full list + citations in the README's "MAP corrections"):
> row 2's endpoint path gains the `/agent` segment; row 12's "schemas are
> `.loose()`" was wrong (the schema is strip-by-default — fields go in as
> loose + optional-forever); "convex reactivity for free" was wrong (web is
> REST-only; the pane needs causal refetch); the endpoint auth cannot ride a
> plain `sessions` scope (VM keys lack it — dual-accept instead); and the
> "Facts the builder must confirm" below are all confirmed. The "Tweakable
> build plan" section at the bottom is **stale** — follow the README's slice
> graph instead.

Feature = three rails that land together:

1. **Mutable session cwd** — the agent can move its session's working
   directory via a new API endpoint; the change is durable, validated against
   the real filesystem, and propagates to future dispatches and the UI.
2. **App pane in the session view** — when the session's cwd sits at or under
   an app's anchor folder, the app renders live in an app-dominant right pane
   beside the chat. Fully declarative: pane state is a pure function of
   `snapshot.cwd`.
3. **Generated "your apps" system-prompt layer** — every agent session learns
   which apps it has, where they live, and that moving the session into an
   app folder shows the user that app. Eager opening is the *desired*
   behavior: when building or editing an app, moving there should be one of
   the agent's first actions.

Origin: today nothing enumerates apps into the system prompt at all — an
agent with bundled apps discovers them only by `ls`. The prompt stack is
exactly `DEVELOPER_SYSTEM_PROMPT` + the agent's `AGENTS.md`
(`packages/gateway/src/agents/agent-context.ts`,
`packages/gateway/src/runner/process-runner.ts:296-314`).

---

## Quadrant 1 — Known knowns (settled ground, all verified in code)

**Prompt assembly seam is ready.** `resolveAgentContext`
(`agent-context.ts:133`) already receives `anchors: GatewayAnchor[]` and
renders ordered `--system-prompt-file` blocks. The onboarding-completion file
(`agent-context.ts:109`) is the working precedent: product-generated prompt
file in the per-agent state dir (outside the drive, mode 0600, regenerated
per spawn).

**Session cwd today is launch-only.** It exists on the `initial_prompt`
delivery (`packages/backend/convex/domains/agentSessions/model.ts:84`),
persists once on the session row (`convex/schema.ts:965`), and no wire event
updates it. The API **re-projects launch data from the durable session row on
every dispatch** (`packages/contract/src/agent/index.ts:739` comment) — so a
row update reaches future dispatches and the UI (convex reactivity) for free.

**Agent binding is stable across cwd changes.** Binding resolves once at
envelope creation and persists as `agentAnchorId`
(`packages/gateway/src/agent-sessions/coordinator.ts:239-263`, `:255`). Every
later spawn uses `resolveBound`, which already throws if cwd leaves the bound
anchor (`agent-context.ts:169`) — the exact constraint chosen in decision 1.
`mergedLaunch` is newest-wins (`agent-sessions/ledger.ts:656`), so a
delivery's re-projected cwd refreshes the envelope.

**UI substrate.** Sessions surface is a horizontal flex row
(`apps/web/spa/routes/sessions.tsx:482`) with the conversation as `flex-1`
`<main>` — the pane drops in as a sibling `<aside>`. The app iframe + status
cards live in `AppView` (`apps/web/spa/routes/apps/apps-surface.tsx:122`,
iframe at `:241`, launch-grant frame source in `spa/apps/app-frame.tsx`).
Mid-build state is already handled *inside the app's own origin*: the gateway
serves a dedicated building page while build activity is hot and upstream is
down (`packages/gateway/src/apps/building-fallback.ts`, `building-page.ts`).

**Scoping rule exists and has a name.** `groupAppsByAgent`
(`apps/web/spa/drive/agent-roster-projection.ts`, used at
`spa/routes/apps.tsx:131`) splits apps into `groups.root` (under no agent
anchor) + per-agent groups. App anchors cannot nest (generalized
`assertLinkedRootDoesNotNest`, see `specs/done/agents/README.md`).

**Gateway app data.** `GatewayAppConfig` carries
`appId/slug/name/command/installCommand/port/anchorPath/apiScopes`
(`packages/contract/src/apps/index.ts:198`) — **no visibility, no
canonicalUrl** (must be added, see decision 12). Desired state is assembled by
`runConfigForWorkspaceImpl`
(`packages/backend/convex/domains/apps/model.ts:546`), which **skips disabled
apps and non-active anchors** (`:558-560`) — the gateway never hears about
them. Config identity comparators are field-by-field
(`sameGatewayAppRuntimeConfig` `contract/src/apps/index.ts:212`,
`sameGatewayAppConfig` `:228`); the backend ignores reconciliation reports
whose echoed config mismatches current (`apps/model.ts:595`).

**Env/endpoint substrate.** Session spawn env carries
`DUET_API_KEY`/`DUET_API_URL` (`model-credentials.ts:50`,
`runtime/http.ts:902`) but no session id. `GET /v1/ws/:ws/apps` exists
(`apps/api/src/routes/apps.ts:44`). Onboarding-completion endpoint
(`apps/api/src/routes/agents.ts`) is the precedent for agent-invoked curl
mutations. Synchronous API→gateway push exists (`apps/api/src/gateway/client.ts`,
agents rail). `MAX_APPS_PER_WORKSPACE = 500`. `AgentCwdSchema` validates
drive-relative containment (`contract/src/agent/index.ts:659`).

---

## Quadrant 2 — Decision ledger

| # | Question | Decision | Closed by |
|---|----------|----------|-----------|
| 1 | cwd semantics | Rebind the **real** session cwd (spawn dir, timeline, attribution all follow). Bound sessions constrained inside their anchor (existing `resolveBound` enforcement); drive-root sessions move anywhere in the drive. No parallel "focus path" concept. | Example User |
| 2 | Invocation | `POST /v1/ws/:workspaceSlug/sessions/:sessionId/cwd`, body `{cwd}`, auth = existing workspace `DUET_API_KEY`. Add `DUET_SESSION_ID` to runner spawn env. Workspace-scoped key can move any session's cwd — accepted, same VM trust domain. | Example User |
| 3 | Pane lifecycle | Fully declarative from `snapshot.cwd`: subtree match against app anchor paths; opens on load if cwd already inside an app; swaps on move; closes when cwd leaves. User collapse is ephemeral component state, wins until the next cwd change; reload re-derives (pane reopens). Non-reconciled apps still open the pane (existing status cards). | Example User |
| 4 | Prompt content | Bound agent → its own apps; root session → `groups.root` only (mirror `groupAppsByAgent`; lift to `contract` so gateway+web share one owner). Per app: name, slug, drive-relative directory, visibility, live URL when public. **No status column** (gateway only receives runnable apps — see card C2). Cap 30 rows + "N more via `GET /v1/ws/:ws/apps`". | Example User + territory |
| 5 | Layout | App-dominant split: chat clamps ~380–520px reading width, app pane `flex-1`. Below `lg`: no split; header chip (icon+name) → full-screen app. No resizer in v1. Extract shared app-frame component from `AppView` instead of duplicating. | Example User |
| 6 | Staleness | Prompt file regenerated at every runner spawn, **byte-deterministic** (sorted by slug, no timestamps, no volatile fields) so the prompt-cache prefix only invalidates on real app-set change. One-line live-list pointer in the prompt. | Example User |
| 7 | Prompt tone on opening | Eager. "When building, editing, or demonstrating an app, move the session there as one of your first actions." | Example User |
| 8 | Who moves cwd | Agent-only in this feature. User-initiated moves (file browser in chat screen, click-to-cd) are a named future spec, out of scope. Endpoint design must not preclude web-app callers later. | Example User |
| 9 | Pane extensibility | Strictly viewing. No overlay/annotation seams in the extracted component. | Example User |
| 10 | Timeline path re-resolution (card C1) | Accept single-cwd resolution; mitigate in the generated prompt: tell agents to prefer drive-absolute paths when showing files (renderer already supports them, `developer-system-prompt.ts:19`). | Example User |
| 11 | Bad cwd must never brick a session (card C5) | Two layers + e2e. (i) Write-time: the API→gateway push is a **precondition** — gateway validates the candidate against the real filesystem (exists, is dir, containment); API commits the row only on gateway OK, else 422 in-turn so the agent can retry. (ii) Spawn-time: `resolveAgentCwd` failure on a session cwd **falls back** (bound → anchor root; default → drive root) with a visible system warning event, never a failed delivery. Heals today's latent brick (delete a live session's cwd folder → every dispatch throws). | Example User |
| 12 | Wire fields for visibility/URL | Add `visibility` + `canonicalUrl` (public only) to `GatewayAppConfigSchema` — additive, schemas are `.loose()`, skew-safe. **Must stay out of both comparators** (card C3). | Territory |

No OPEN items.

---

## Quadrant 3 — Unknown knowns (extracted context)

- **Prompt-cache discipline came from Example User unprompted**: any prompt byte
  churn invalidates the whole prefix next turn. This produced decision 6 and
  dropped transient status (`reconciling`) from the listing.
- **Root scope mirrors the UI on purpose**: the default agent's prompt list
  must match what the user sees in the apps sidebar (`groups.root`), so agent
  and user talk about the same set.
- **Eager opening is a product stance**, not a tolerance — the pane is the
  demo surface for app-building sessions.
- **The pane is strictly a viewer**; the app-creator feedback-loop ideas
  (viewer annotations, usage-as-prompt) are explicitly *not* being seeded
  here.
- **Sample prompt file** (approved shape; wording tweakable at build time):
  bullet list per app — `**Name** (`slug`) — `dir` — private|public
  (https://…)`; mechanics section with the curl (workspace slug baked in at
  generation, no `whoami` dance; `$DUET_SESSION_ID` from env); note that the
  user sees building/broken states safely; absolute-path guidance (decision
  10); live-list pointer.

## Quadrant 4 — Unknown unknowns (landmine cards)

- **C1 — timeline re-resolution** (decided → row 10). Evidence:
  `sessionTimelineCwd` (`sessions.tsx:170`) yields ONE cwd for the whole
  timeline; old messages' relative media re-resolve after a move.
- **C2 — disabled/broken apps never reach the gateway** (absorbed → row 4).
  Evidence: `apps/model.ts:558-560`. The prompt cannot list them; every
  listed app is runnable.
- **C3 — comparator exclusion rule** (sharp edge, binding). New
  `visibility`/`canonicalUrl` fields must NOT be added to
  `sameGatewayAppConfig`/`sameGatewayAppRuntimeConfig`
  (`contract/src/apps/index.ts:212,228`): a skewed gateway echoing configs
  without them would mismatch at `apps/model.ts:595` and stick every app in
  "reconciling" (incident class already seen in apps-in-file-view). Bonus:
  visibility toggles don't restart app processes.
- **C4 — wake-with-stale-cwd** (decided → row 11.i). Evidence: envelope
  launch refreshes only on deliveries (`ledger.ts:656`); scheduled wakes
  spawn from `envelope.launch.cwd` (`coordinator.ts:607,786`). The
  synchronous gateway push updates the envelope, closing the gap.
- **C5 — bad cwd bricks the session** (decided → row 11). Deadlock: spawn
  throws → turn never runs → agent can never fix its own mistake. Also a
  latent today-bug via folder deletion.
- **C6 — `DUET_SESSION_ID` placement**: cannot ride `modelEnvForSpawn`
  (session-independent, `http.ts:902`); inject in `defaultRunnerFactory`
  (`process-runner.ts:296`), which already holds the sessionId.
- **C7 — prompt hygiene**: app names are user-authored text entering the
  prompt; render single-line in backticks, strip newlines. Same-workspace
  trust domain — injection is self-directed only.
- **C8 — done-conditions** (project rule): dedicated staging e2e journey in
  `packages/test-harness` registered in `src/staging-e2e-synthetic`,
  covering: agent moves cwd → pane data changes; garbage cwd → 422 + session
  still answers. Spawn-time fallback covered by gateway integration tests
  (staging can't safely delete drive folders mid-session). Visual gates
  (ui-playground + screenshot-critique) for the pane layout.

## Facts the builder must confirm before coding

- Exact projection path of `cwd` into the session snapshot query
  (`convex/domains/agentSessions/queries.ts`) — confirm the row patch
  surfaces reactively without a new subscription.
- Where the gateway persists its current desired-apps snapshot for the prompt
  generator to read at spawn (desired-state store vs. anchors registry).
- `groupAppsByAgent` lift to `contract`: check its inputs are all available
  gateway-side (agents' anchor paths are — `GatewayAnchor.kind === 'agent'`).
- Endpoint file placement: sessions-shaped routes live in
  `apps/api/src/routes/agent.ts` — follow whatever grouping that file uses.
- The UI join for the pane: `AppListResponse` already carries `anchorPath`?
  (UI currently gets it — verify the field, else extend the response.)

## Tweakable build plan (sorted by likelihood-of-tweaking, not order)

1. **Prompt file wording** — sample above is approved shape; expect edits.
2. **Pane trigger UX** — collapse affordance, swap behavior, mobile chip
   styling. Layout decision (row 5) is fixed; the affordances aren't.
3. **422 error body + fallback warning copy** — agent-facing strings.
4. **Endpoint path/shape** — `POST …/sessions/:id/cwd` chosen; body/response
   details flexible.
5. Mechanical (trusted): contract fields + comparator exclusion; vm-sync
   plumb; `DUET_SESSION_ID`; convex mutation + gateway push precondition;
   spawn fallback; extract shared app-frame component; `groupAppsByAgent`
   lift; prompt generator; pane; chip; tests + staging journey.
