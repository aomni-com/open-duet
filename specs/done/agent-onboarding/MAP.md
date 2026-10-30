# Agent onboarding, trainable, and agent-linked campaigns — quadrant map

Quadrant walk completed 2026-07-26 (Example User + Claude). This map is the binding
planning record for the feature; `write-spec` slices start from it. Every
decision below was closed on-screen; OPEN items say what unblocks them.

**The feature in one paragraph:** An agent may declare an optional
**onboarding** in `agent.json` — a chat (system prompt swapped to
`ONBOARDING.md`) or a dedicated app. Until the workspace's copy of the agent
is marked onboarded (`onboardedAt` on the agents row, set via a REST toggle
the onboarding chat/app itself calls), the agent's UI collapses to a single
"Onboard agent" button (train and management stay). Completion lands the user
in the agent's new-session page with confetti and a congrats moment. A
separate `trainable: false` config hides the train surface. Campaigns can
carry `starterAgents: string[]`; signing up through such a campaign's lander
auto-installs those agents, skips the agent-selection onboarding step, and
chains their agent onboardings immediately after Duet's own onboarding.

---

## 1 · Known knowns (the settled ground)

- **Agents** are per-workspace Convex rows (`agents`,
  `packages/backend/convex/schema.ts:555`) over anchored drive folders; share
  replicas and official installs materialize their own row per workspace — so
  per-workspace `onboardedAt` is a field on the row, no new table.
- **`agent.json`** is synced drive content parsed by `AgentConfigSchema`
  (`packages/contract/src/agents/index.ts:14`), read by the gateway
  (`packages/gateway/src/agents/agent-config.ts`) and the web
  (`apps/web/spa/routes/agents/agent-mode.ts`). Parse failure never blocks a
  session (auto + warning).
- **Both onboarding callers already have credentials:** sessions get
  `$DUET_API_KEY` (used by `manage-agents` via
  `apps/api/src/routes/agents.ts`); apps get `DUET_APP_API_KEY` +
  `DUET_API_URL` at spawn (`packages/gateway/src/runtime/http.ts:328`,
  `app-credentials.ts`) with declared scopes; an `agents` capability exists
  (`packages/contract/src/scopes/`).
- **The UI to gate:** roster card `AgentRosterCardView`
  (`apps/web/spa/drive/agent-roster-rail.tsx`), agent detail canvas
  (`spa/routes/agents/agent-detail-canvas.tsx`), per-agent train route
  `computer/train/agents/:agentSlug`. The roster brain icon is default-agent-only.
- **Duet onboarding already installs official agents at completion:**
  `POST /v1/ws/:ws/onboarding` (`apps/api/src/routes/marketplace.ts`)
  completes workspace onboarding, runs `marketplace/model:install` per
  selected name, then pushes a gateway pull. Steps are a config array
  (`identity → team → knowledge → ready`,
  `apps/web/spa/onboarding/onboarding-config.ts`); agent selection renders on
  the `team` step (`onboarding-experience.tsx:304`).
- **Campaign intent survives signup:** campaigns are typed code constants
  (`packages/backend/convex/domains/campaigns/config.ts:57`); the lander mints
  attribution pre-signup; the user row carries immutable
  `acquisitionAttributionId` (`schema.ts:167`).
- **Default agent = drive root, not an agents row** (`ROOT_AGENT_SCOPE`) — the
  new settings cannot apply to it by construction; always trainable;
  descendants inherit curated root memory via existing rails.
- **Web is REST + TanStack Query** — no Convex live queries; slow-state
  watching uses conditional `refetchInterval`
  (`spa/api/query-options.ts:103,303`); sessions have a per-session SSE
  stream (`spa/api/stream.ts`).

## 2 · Decision ledger (known unknowns — closed)

| # | Question | Decision | Closed by |
|---|---|---|---|
| D1 | Who authors the settings | Agent dev, in `agent.json` | Example User |
| D2 | Onboarding chat mechanism | True system-prompt swap: gateway points `--system-prompt-file` at `ONBOARDING.md`; launch wire gains optional `onboarding` flag; onboarding sessions skip forced `mode` | Example User |
| D3 | Mark-onboarded endpoint | `POST /v1/ws/:ws/agents/:slug/onboarded` `{ onboarded: boolean }` toggle mirroring `/disabled`; sets/clears `onboardedAt` | Example User |
| D4 | Finding the onboarding session | `onboarding: true` stamped on the session row at creation; open newest non-archived, else create | Example User |
| D5 | Landing-page link | Campaign carries `starterAgents: string[]` (multi-agent blanket support); acquisition attribution → server-side auto-install at onboarding completion; `team` step skipped when campaign carries agents | Example User |
| D6 | Lock hardness | UI-only; API fully open — onboarding chat/app calling other endpoints is a valid use case | Example User |
| D7 | Hidden app | `hideAfterOnboarded?: boolean`, default `true`; client-side display filter only — app stays published, running, linkable | Example User |
| D8 | `trainable: false` gates | UI-only: Train button hidden, train route shows a disabled empty-state (no redirect); memory/inheritance rails untouched (explicitly rejected) | Example User |
| D9 | Config appears on an in-use agent | Lock purely derived (`onboarding declared && !onboardedAt`), effective immediately — deliberate dev lever; "Redo onboarding" agent-menu item calls the D3 toggle with `false` | Example User |
| D10 | Chained multi-agent onboarding order | Sequential; mid-chain completions skip the congrats page and go straight to the next agent; final agent gets the M2 moment | Claude (decide-and-inform, unobjected) |
| D11 | Onboarding sessions in lists | Hidden from **all** session lists (roster cards, jobs, search); post-onboarding the user lands in the agent's new-session page | Example User |
| D12 | Onboarded moment | Confetti + congrats on the agent's new-session page (M2 center-stage empty state, fades on first message) | Example User |
| D13 | Schema doctrine | `.strict()` is an anti-pattern repo-wide. Declared fields validate hard (missing required / wrong type fails); unknown fields pass. Loosen every schema touched; audit remaining `.strict()` uses. **Deliberately overturns** the shipped launch-wire invariant in `specs/done/agents/README.md` | Example User |

**Formerly-OPEN items, closed at write-spec kickoff (Example User 2026-07-26):**

- **O1 — closed:** campaigns use **official agents only**, but ordinary users
  must be able to author onboarding-capable agents and share them to other
  workspaces. So the `manage-agents` skill and public API docs ship the
  onboarding/trainable sections **in the same change**, and the share-replica
  path (recipient sees the locked card, onboards per-workspace) is a
  first-class scenario, not an edge case.
- **O2 — closed:** no real lander page; the campaign → signup → auto-install →
  chained-onboarding path **must be a staging e2e scenario** (the harness
  does real magic-link sign-in; campaign attribution is mintable without a
  lander page).
- **Given (accepted):** ships with its own staging e2e journey registered in
  `packages/test-harness/src/staging-e2e-synthetic`
  (config → locked card → onboarding → mark-onboarded → unlocked + hidden
  app), run per the repo's closeout convention.
- **Closeout requirement (Example User, write-spec kickoff):** the spec ends with a
  full release slice — gateway release, VM image rebuild + pin/promotion,
  env/secret pushes, and deploys for **both staging and prod**.

## 3 · Unknown knowns (extracted taste and tacit context)

- **Locked card = V2 "Compact":** the standard card header (avatar, name,
  status dot, role line), body replaced by one full-width brand
  "Onboard agent" CTA. Management ⋯ menu stays. Least layout shift on unlock.
- **Onboarded moment = M2 "Center-stage":** the new-session page's empty
  state *is* the congrats (🎉 + "«Agent» is ready" + subline), with confetti;
  fades on first message. Not a banner.
- **Confirmed spellings:** `onboarding.kind` (`'chat' | 'app'`),
  `ONBOARDING.md`, `hideAfterOnboarded`, `trainable`, campaign
  `starterAgents`, endpoint `…/onboarded`.
- **`onboarding.app` is a path relative to the agent root, never a slug**
  (D-F1). Rider: devs may place the app in a dot-folder
  (`".onboarding/style-picker"`) to keep it out of users' way — contract
  path validation permits dot-segments (`relative-path/index.ts:18`).
- **The retroactive lock is a feature:** adding onboarding to a shipped agent
  is the dev's lever to force existing workspaces through new setup; soft
  because UI-only.
- **Schema doctrine phrasing (Example User verbatim):** "if existing data don't have
  required field, or if field wrong type it should obviously fail. otherwise
  let it through."

## 4 · Unknown unknowns (landmine cards)

| # | Finding | Evidence | Status |
|---|---|---|---|
| F1 | Slug-based `onboarding.app` breaks on replicas — collision suffixing (`style-picker` → `style-picker-2`) while config is byte-identical synced content; could even point at the recipient's unrelated app | `domains/replication/shared.ts:131-134` | **Decided:** resolve by path within the agent's own folder (D-F1) |
| F2 | `triggers` is *required* in today's `AgentConfigSchema` — `{"trainable": false}` alone would be "Invalid agent.json" | `contract/src/agents/index.ts:16` | **Decided:** make optional in the loosening pass |
| F3 | Nothing tells the web `onboardedAt` flipped (no live queries) | precedent `query-options.ts:103,303` | **Decided:** conditional poll of the agents list while an onboarding surface is open (~2-3s); SSE piggyback rejected |
| F4 | Search leaks hidden sessions unless the flag joins `search_sessions.filterFields`; cache matcher must learn the dimension in the same change as the key (agents-ui L7 rule) | `schema.ts:1038`; `sessionMatchesStructuralFilters` | Sharp edge — build requirement |
| F5 | Chained onboarding races the install — **corrected during drafting:** `createSubscription` registers the agents row + anchor *synchronously* (`marketplace/model.ts`), so `anchorState` is `active` and the config read fails open to *unlocked* while folder bytes are still landing. The wait state must key on `subscription.state !== 'active'` **alone**, never `anchorState` or the lock | `marketplace/model.ts`, `contract/src/anchors/index.ts:6` | Sharp edge — build requirement (corrected) |
| F6 | Campaign installs must derive server-side from `acquisitionAttributionId` → campaign → `starterAgents`; client `selectedNames` is not the carrier | `schema.ts:167` | Sharp edge — build requirement |
| F7 | **CORRECTED during drafting — the original card was wrong.** An old gateway does NOT ignore an unknown launch field: `GatewayRunnerInputRequestSchema` is `.strict()` with a nested `.strict()` `launch` (`contract/src/agent/index.ts:792-820`) and the gateway 400s any parse failure (`gateway/src/routes/agentSessions.ts:32-33`), which the API propagates. Skew = **sessions on stale VMs reject every input**, not a wrong prompt. Mitigation: the schema-loosening contract slice deploys to both envs on its own, before anything sends `launch.onboarding`; fleet convergence confirmed before the sender ships (deploy ordering, not a compat shim) | verified live in code 2026-07-26 | Sharp edge — deploy-ordering requirement |
| F8 | Locked card needs per-card config read; unreadable/malformed config ⇒ card renders **unlocked** (fail-open), matching "parse failures never block" | `agent-config.ts:37` invariant | Sharp edge — build requirement |

**Small facts the builder confirms before coding (map entries, not footnotes):**

1. Dot-folder app smoke: register + `resolveAppFolder` an app at
   `".onboarding/<name>"` end-to-end (contract allows; verify gateway + drive
   UI behavior).
2. The exact list of `.strict()` / `strictObject` usages touched by this
   build, each loosened per D13 (full-repo audit may trail as its own pass).
3. ~~Confirm the session-create seam paths~~ **Confirmed during drafting:**
   `launch` is rebuilt from the prepared dispatch lease on *every* input
   (`apps/api/src/agent-runner.ts:448-462`), and the gateway relaunches from
   `args.launch` on resume. So `onboarding` has ONE source of truth — the
   Convex session row, stamped at create — and the API projects it onto
   `launch` in `runnerInputRequest`. A client-sent flag would silently
   relaunch turn 2 under `AGENTS.md`.
4. `computer/train/agents/:slug` empty-state copy for `trainable: false` (D8 — no
   silent redirect).

## ~~Tweakable plan~~ — SUPERSEDED

> **Superseded 2026-07-27 by the sliced spec, which then shipped:** the 15-slice
> build ladder (a three-draft synthesis) has been folded into
> [`README.md`](README.md) and its `slices/` directory deleted, as closing a
> spec does. This section and the kickoff prompt below are kept as provenance
> only — do not implement from them.

## Tweakable plan (sorted by likelihood-of-tweaking, not execution order)

1. **Judgment — contract shapes:** `AgentConfigSchema` gains
   `onboarding: { kind: 'chat' } | { kind: 'app', app: <relative-path>, hideAfterOnboarded?: boolean }`
   and `trainable?: boolean` (default true); `triggers` optional; loose
   objects per D13. `Agent` schema + row gain `onboardedAt?`. Launch wire
   gains `onboarding?: boolean`.
2. **Judgment — locked-card + onboard flow UI:** V2 card, button target by
   kind (chat → onboarding session; app → in-product app view), picker
   exclusion, "Redo onboarding" menu item, M2 + confetti on flip (F3 poll).
3. **Judgment — campaign chain UX:** `team`-skip, server-side install
   derivation (F6), wait state (F5), sequential chain (D10).
4. **Mechanical (trusted):** D3 endpoint + Convex mutation; session
   `onboarding` stamp + list/search/matcher filters (F4); gateway prompt swap
   + mode skip (D2); `trainable` UI gating (D8); hidden-app filter (D7);
   `manage-agents` + docs (pending O1); staging e2e journey.

## ~~Implementation kickoff~~ — SUPERSEDED (the feature shipped 2026-07-27)

> (Historical. The build is done; see this folder's README.) /write-spec
> agent-onboarding — slice from specs/done/agent-onboarding/MAP.md;
> the map is binding: decisions D1-D13 are givens, F-cards are build
> requirements, OPEN items O1/O2 resolve or stay explicitly deferred.
