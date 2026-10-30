# Agents UI — quadrant map

Planning record for the web surface deferred out of the headless
[`agents`](../agents/README.md) build. Produced by an `explore-unknowns`
quadrant walk on 2026-07-21. Every decision below is closed and phrased so a
spec can carry it verbatim as a given; nothing here is a discussion to reopen.

**This map is the decision record; [`README.md`](README.md) is the build plan
derived from it.** The README replaced an earlier starter spec that described a
picker plus badges bolted onto the existing rail — the walk decided the rail
becomes an agent roster instead, and that starter text is gone. Where map and plan
disagree about a *decision*, the map wins.

---

## Quadrant 1 — Known knowns

**The task.** Make agents reachable and legible in `apps/web`. The backend
shipped 2026-07-21 and is on staging; nothing in the web app consumes it yet.

**What the backend already gives us**

| Fact | Evidence |
|---|---|
| `SessionSummary.agent?: {id,name}`, inherited by `JobSummary` + `SessionSnapshot` | `packages/contract/src/sessions/index.ts:29`; projected by `sessionAgentIdentity` in `packages/backend/convex/domains/agentSessions/agentSessionsShared.ts` |
| Zero usages of that field anywhere in `apps/web` | grep, 2026-07-21 |
| Session create already accepts `cwd`; the web app never sends it | `packages/contract/src/agent/index.ts:729`; `apps/web/spa/routes/sessions.tsx:422` |
| Full agent CRUD is live | `apps/api/src/routes/agents.ts:26,36,57,79` |
| `Agent` carries `slug/name?/icon?/anchorPath/anchorState/sourceShareId?/disabledAt?` and nothing else | `packages/contract/src/agents/index.ts` |
| The SPA client has app methods but **no** agent methods | `apps/web/spa/api/client.ts:336,427,466` |
| `resolveNearestAgent(cwd, candidates)` is exported, pure, and the single owner of the nearest-agent rule | `packages/contract/src/agents/index.ts` |
| The drive file provider has read, write, and `mkdir` | `apps/web/spa/files/lib/rest-provider.ts:62,86` |
| `ComposeBar` takes optional picker capabilities (`model`, `reasoning`) as generic data objects | `packages/ui/src/components/compose-bar/types.ts:12,221` |
| Jobs is a 3-column fixed table (Job / Activity 15rem / State 20rem, last two `xl`-only) | `apps/web/spa/jobs/jobs-table.tsx:19` |
| Workspace queries have no `refetchInterval` | `apps/web/spa/api/query-options.ts:13` |

**The load-bearing framing.** The product shell's first tab is already called
**Agents**, and it renders a 20rem rail above a single hardcoded "Duet" card
holding that agent's apps and sessions
(`apps/web/spa/drive/agents-workspace.tsx:260-262`). The tab is plural; the
content is one static identity.

> **Correction (verified 2026-07-21).** An earlier draft of this map quoted the
> rail header as `AGENTS / Installed`. It is not: `t('installed')` renders
> **"Default AI"** and `t('role')` renders "Your default AI for this drive"
> (`apps/web/messages/en/app.json:166-167`). The framing argument survives — the
> tab is "Agents", the card is one static default identity, and the roster was
> omitted for lack of an entity — but the roster's copy is a **rewrite in both
> locales**, not a reuse of an existing "Installed" string.

**And it was withheld on purpose.** `specs/drive-shell-port/CUTOVER-REPORT.md:48`
records `installed-agent cards/count | OMITTED | OMITTED | no installed-agent
entity`, and `:142` — *"Multiple installed agents, skills, Discover, and
ownership groupings remain omitted. They require a real agent roster/relationship
contract."* The reference UI had the roster; Duet omitted it for lack of an
entity.

**Stronger than an empty checkbox: it left a tripwire.** `slices/03-agents-rail.md`
in that spec instructed its implementer to strip `role`, `skills`, and
app/session-ownership from the reference component, and closed with a standing
order: *"Any request for multiple installed agents, skills, or agent↔app/session
ownership triggers the report/stop condition rather than a frontend
approximation."* That condition fired here. It was **discharged on 2026-07-21** in
both places it lives — the slice file and the ledger rows now name this spec as
the successor owner. So D9 is not "the slot is empty, we'll fill it"; it is the
answer to a question that spec deliberately deferred to whoever came next. The agents API is that entity, so **this spec is an un-omission, and the
component exists**: `~/dev/chat-app/packages/ui/src/components/common/installed-agents-sidebar.tsx`
(442 lines, at the revision pinned in `specs/drive-shell-port/assets/01-reference/README.md`).

```ts
InstalledAgentSidebarAgent = { id, name, role, skills[], sessions[], apps[] }
InstalledAgentsSidebarProps = { agents, activeAgentId, activeSessionId, activeAppId,
  builtInAgentId, onSelectAgent, onSelectSession, onSelectApp, onCreateSession,
  renderAgentAvatar, sessionPreviewLimit, skillPreviewLimit, copy, … }
```

`builtInAgentId` ↔ the default Duet agent. `onCreateSession(agent)` ↔ D3.
`discover` has no Duet equivalent and is omitted. Per `drive-shell-port` rule 1,
the visual slices are a **port with sign-off**, not an invention.

**Assumptions treated as settled.** Web + the one skill edit only (no CLI/runner
work); `manage-agents` remains the authoring path; `agent.json.triggers` stays
out of scope.

---

## Quadrant 2 — Known unknowns (decision ledger)

| # | Decision | Why | Closed by |
|---|---|---|---|
| **D1** | The rail becomes the **agent roster**: the hardcoded Duet card becomes the default agent (drive root); every registered agent gets a card with its own apps and sessions. | The header already claims "Installed" over one fake card; the reference component exists. | user |
| **D2** | Add `agentId?` to `SessionListQuery` and query **per card** (one infinite query each). `'root'`/undefined selects sessions with no agent. | Client-side grouping of one paginated list yields half-empty cards and counts that are really "N loaded". | user |
| **D2a** | Per-card **apps** group client-side via `resolveNearestAgent(app.anchorPath, agents)`. No backend. | `App.anchorPath` and `Agent.anchorPath` both exist; reusing the shipped helper keeps one nearest-agent rule in the system. | territory |
| **D3** | A card's **New session** routes to `/w/:slug/sessions/new?agent=<slug>`, preselecting a ComposeBar agent picker that can still be changed before the first message and becomes a static chip after create. | Rail is the fast path; the picker preserves the original goal and deep links. | user |
| **D3a** | The picker is a **new named capability** on `ComposeBar` (`agent?: ComposeBarPicker<AgentId>`), not a reuse of the `reasoning` slot. | The compose-bar README's stated rule: optional features are capability objects, and the primitive never imports product services. | territory |
| **D4** | New route `/w/:slug/agents/:agentSlug` renders an agent detail canvas: identity, path, rendered `AGENTS.md`, `mode` from `agent.json`, skills from `.agents/skills/`, its apps and sessions, and the ⋯ menu. **Config is read-only.** | Mirrors how an app icon opens `/apps/:slug`; authoring stays in the drive and the skill. | user |
| **D5** | **Creation is conversational.** `[+ New agent]` opens `/sessions/new?agent=root` with a prefilled prompt; `manage-agents` does mkdir → `AGENTS.md` → `POST /agents`. No create dialog, no client-side registration. | Agents are authored by agents; avoids a 3-step non-atomic frontend orchestration. | user |
| **D6** | The UI **owns rename, delete, and share**: `PATCH`, `DELETE`, and the existing folder-share dialog pointed at the agent's `anchorPath`. | Single atomic calls; the share dialog already exists and handles recipients and permissions better than a prompt. | user |
| **D7** | `manage-agents` ends a create by emitting a **root-relative** markdown link (`[Research](/w/<slug>/agents/<slug>)`); the session message renderer intercepts same-origin links via `Markdown`'s `onLinkClicked` and navigates in-SPA. | The sandbox gets `DUET_API_URL` but no web-app URL (`packages/gateway/src/runtime/http.ts:723`); the alternative was threading `DUET_APP_URL` through gateway + provisioning + secret topology to build a string. | assistant (user-informed) |
| **D8** | Roster freshness: when an agent route names a slug absent from the cached roster, invalidate the agents query once. No polling. | Fires exactly on arrival via Duet's link; the rail also refetches on window focus. | user |
| **D9** | Proceed now rather than queueing behind `drive-shell-port`; agents-ui takes ownership of the rail and **must flip `CUTOVER-REPORT.md:48` and `:142`** from OMITTED to shipped. | That spec's open slices (05–09) are Drive/Integrations; the rail slices (03/04/11) are done. Leaving the ledger stale makes two specs disagree about what the rail is. | assistant (user-informed) |
| **D10** | `role` and `skills` are **derived from files**: `role` = first non-heading line of the agent's `AGENTS.md`; `skills` = listing of `<agent>/.agents/skills/`. No contract change. | Always true to what the agent actually is. Cost is 2 reads per agent — see SE-1. | user |
| **D11** | Jobs attribution is a **chip inside the Job cell**, plus an agent filter in the Jobs header (`agentId` on `JobListQuery` too). No chip means the default agent. | Survives every breakpoint without column surgery; the filter rides the same index as D2. | user |
| **D12** | Agent states reuse the **app-status vocabulary** (dot tint + pill) — `shared` for `sourceShareId`, `disabled` for `disabledAt`, `broken` for `anchorState`. **`apps/web/spa/apps/app-status.ts` is extracted to a shared owner** consumed by both apps and agents. | One status projector, not two that drift. Extraction is the user's explicit instruction. | user |

---

## Quadrant 3 — Unknown knowns (extracted taste)

| # | Decision | Why it reshapes the build |
|---|---|---|
| **D13** | **Density is asymmetric.** The active agent's card shows its full, paged session list; every other card caps at 3 sessions with a "Show all" affordance. | Rules out both a plain accordion and a uniform preview list. The active card holds a paging query; inactive cards hold a fixed `limit: 4` query. |
| **D14** | **Search spans agents and flattens.** Typing collapses the roster into one result list across all agents, each row carrying its agent chip; clearing restores the roster. | The rail has two query shapes, not one: roster mode = N agent-scoped queries; search mode = the existing single un-scoped query with `search`. That is a state machine to design, not a filter to add. |
| **D15** | **The default agent is pinned first**, keeps the Duet avatar and "your workspace assistant" role line, and its ⋯ menu omits rename/share/delete (it has no agent row and no anchor). Whether it keeps its brand tint or flattens to match the other cards is a **visual-gate variable**, settled by the screenshot comparison rather than upfront. | Prevents a builder from inventing a synthetic agent row for the drive root, and prevents a pixel argument in prose. |
| **D18** | **"Show all" carries no count.** Cards request `limit + 1` to learn whether more exist and render "Show all" without a number. | Convex pagination returns a page, not a total; the reference copy is `showAllSessions(count)`. Recorded as an adaptation in the cutover report. |

---

## Quadrant 4 — Unknown unknowns (landmines)

Sweep covered the 19 files this task touches: the Convex session query and
schema, the sessions/jobs contract, the API routes, the rail, `drive-routes`,
`sessions.tsx`, `session-data`, the SPA client and query-options, the jobs
table/row, `app-status`, `compose-bar`, `markdown`, `share-dialog`, the skills
registry, the playground registry, and the visual baselines.

### L1 — `agentId` costs two new indexes, not one · **decided**

`domains/agentSessions/queries.ts:105-135` is a branch tree over three access
paths: the `search_sessions` search index, `by_workspace_archive_job_view_status_updated`,
and `by_workspace_archive_job_view_updated` (`schema.ts:789-822`). Convex
requires equality on every index prefix field before the ordering field, so
`agentId` cannot be inserted into the existing indexes without destroying
`updatedAt` ordering for the unfiltered case.

Two agent-variant indexes are needed, **and** `search_sessions.filterFields`
needs `agentId` added or search-within-an-agent cannot combine. Headroom is
fine: 7 indexes (limit 32), 5 filter fields (limit 16).

> **Correction (verified 2026-07-21, and all three drafts caught it).** This card
> originally said "both non-search branches." `listSessionsImpl` actually has
> **three** non-search branches over **four** indexes: `archived≠include`+status
> (`queries.ts:116`), `archived≠include` (`:127`), and an `archived:'include'`
> branch (`:137-155`) that itself picks between
> `by_workspace_visible_job_view_updated` and
> `by_workspace_visible_job_view_status_updated`. Two new indexes cover the
> archive-based paths only — **`agentId` + `archived:'include'` has no index.**
>
> **Decision (D19):** reject that combination at the contract level with a
> `.refine` (a 400), rather than adding two more indexes or silently falling back
> to an unscoped scan. The SPA cannot produce it: `SessionListKeyFilters.archived`
> is `'exclude' | 'only'` (`apps/web/spa/api/query-keys.ts:22`). Pin the
> rejection with a test.

### L2 — the Duet card's query filters on `undefined` · **confirm before coding**

`schema.ts:771` — `agentId: v.optional(v.id('agents'))`; root sessions carry no
`agentId`, so the default card's query is `q.eq('agentId', undefined)`. This is
believed to work and was **not** proven. The most-used card in the product
depends on it. Open the backend slice with a probe, exactly as the agents build's
Slice 02 probe caught `--system-prompt-file` being singular.

### L3 — deleting an agent orphaned its sessions · **decided, and it changes the backend**

Attribution is an immutable stamp and the shipped invariant is that
renames/deletes never rewrite history, so a deleted agent's sessions keep
pointing at a card that no longer exists.

**Decision (D16): `deleteAgent` terminalizes the agent's non-terminal sessions.**
Deleting an agent stops its live sessions and leaves no active jobs. The rail
therefore renders **no ghost cards**; orphaned history stays reachable through
Jobs history, flattened search (D14), and direct URL. A dedicated "deleted
agents" section is explicitly **future work, not this spec**.

The machinery already exists: `continueSessionTerminalizationForWorkspace`
(`domains/agentSessions/events.ts:190`) is a batched, self-rescheduling sweep
that appends an `interrupted` event, patches status, and moves jobs to
`jobView:'history'` (`:286-318`). Delete-an-agent is that sweep scoped by
`agentId` with `error:'agent_deleted'` — and it can ride the index L1 adds.
`deleteAgent` (`domains/agents/model.ts:176`) touches no sessions today, so the
behavior is new even though the mechanism is not.

### L4 — wiring D7 naively breaks every external link in agent messages · **decided**

`packages/ui/src/components/common/markdown.tsx:34-48` — when `onLinkClicked` is
supplied, the component calls `e.preventDefault()` on **every** anchor and
delegates. Nothing supplies one today, so links open in a new tab. A handler that
only knows how to route `/w/...` silently makes every `https://` link an agent
posts inert, and no existing test would catch it.

**Fix:** the branch lives in one pure function — same-origin path → React Router
navigate; everything else → `window.open(href, '_blank', 'noopener')`. Pin both
branches with a test, including protocol-relative and `mailto:`.

> **Correction (verified 2026-07-21).** This card originally named
> `session-message.tsx:125` as the wiring site. **Wrong file.** That component
> renders `ProjectedUserMessage` — the *user's* text. Agent-authored markdown
> goes through a **second, separate** `MessageMarkdown` in
> `apps/web/spa/sessions/ordered-agent-parts.tsx:28,193`. Wiring only
> `session-message.tsx` would leave Duet's own emitted link (D7) dead on arrival.
> Both call sites take the handler; the branch function has one owner.

### L5 — the rail being replaced has no approved visual baseline · **sharp edge**

`drive-shell` is a registered playground scene
(`apps/web/app/playground/registry.ts:60`), but of 286 baseline scenes **zero**
are drive-shell or agents-rail. `CUTOVER-REPORT.md`: *"The Docker visual gate
remains unavailable because the local Docker daemon did not respond. These local
Chromium captures are review evidence, not approved Docker baselines."*

AGENTS.md requires `compare-screenshots` against a prior look and there is none.
The comparison references are the chat-app component and
`specs/drive-shell-port/assets/03-agents/*.png`; agents-ui establishes the first
real Docker baseline for this surface.

### L6 — the shell playground scenes are misnamed and mis-covered · **investigated, scheduled**

Not a dead scene. `product-shell` renders `SpaShellPlayground`
(`apps/web/app/playground/render-map.tsx:46`), which is live; the deleted
`ProductShell` (slice 11) only left its **name** behind — on the registry id, the
title *"Product shell — sessions route"* (`registry.ts:126`), **57** occurrences
of `playground/product-shell` in `apps/web/tests/visual/playground.spec.ts`, and
**95** explicitly-named `product-shell-*.png` baselines.

> **Correction (verified 2026-07-21 by count).** This card originally estimated
> "roughly twenty goto strings and about ten baselines." The real numbers are
> **57 and 95** — roughly 5× and 9×. It is still mechanical, but it is a slice of
> its own and it cannot be attempted without the Docker gate available.

The real defect is the pairing: the scene named after a deleted component owns
ten baselines, while `drive-shell` (`render-map.tsx:31`) — the shell agents-ui is
about to rewrite — owns **none** (L5).

**Fix, scheduled into this spec rather than done out of band:** rename the scene
to `spa-shell` (registry id, render-map key, goto strings, test titles, baseline
filenames) in the same pass that establishes the first `drive-shell` baselines.
Both are baseline-affecting edits to one surface, and both need the Docker visual
gate to verify — renaming baselines without running that gate would be an
unverifiable change.

### L7 — the session cache will mis-file rows into every agent's card · **decided**

*Found by the seam-quality draft; missed by my sweep and by the other two drafts.
Verified 2026-07-21.*

`sessionFiltersFromKey` (`apps/web/spa/sessions/session-cache.ts:179-191`)
reconstructs a list's filters from its query key and returns only
`{search, archived, status}` — it silently drops any dimension it doesn't know.
`sessionMatchesStructuralFilters` (`:193-201`) then decides which cached lists a
mutated session belongs in, and it has no agent branch.

**Why it bites:** D2 puts `agentId` in the session query key. Without teaching
those two functions, **every** optimistic mutation — create, rename, archive,
delete, and the SSE status bump through `patchSessionSummaryCaches` — splices the
session into *every* agent's card. The symptom is intermittent, invisible to
screenshots, and looks like a backend filtering bug.

**Decision (D20):** the key filter type and the cache matcher are edited in the
same slice, always. `sessionMatchesStructuralFilters` gains
`(summary.agent?.id ?? ROOT_AGENT_SCOPE) !== filters.agentId → false`. A filter
dimension the matcher doesn't know is a defect class, not a feature.

### L8 — replica agents reject rename and delete with a 403 · **decided**

*Verified 2026-07-21.* `assertMutableOriginAgent`
(`packages/backend/convex/domains/agents/model.ts:187,266-271`) throws
*"Replica agents are read-only"* for any agent carrying `sourceShareId` or
`sourceAgentId`, and `apps/api/src/routes/agents.ts:113` maps that to **403**.

**Why it bites:** D6 gives the UI rename/delete/share, and D15 exempts only the
*default* agent. A shared-in agent would therefore render Rename and Delete
buttons that always fail — and shared agents are the *primary* sharing case this
whole feature was built around.

**Decision (D21):** the card menu has **three** shapes, not two —
`default` (Open in Drive only), `agent` (rename/share/delete), and `replica`
(share + Open in Drive; rename and delete omitted). Eligibility comes from
`sourceShareId`/`sourceAgentId`, mirroring the backend guard rather than
re-deriving it.

### L9 — the terminalization sweep needs three parameters, not one · **decided**

*Verified 2026-07-21.* The map's claim that "the machinery already exists" is
true but understated. `continueSessionTerminalizationForWorkspace`
(`domains/agentSessions/events.ts:190`) **early-returns unless the workspace's
`servicingStatus` is paused/banned** (`:194-200`), and `terminalizeSession`
hard-codes `error: 'workspace_paused'` (`:301`).

**Decision (D22):** D16 parameterizes three things — the candidate source
(workspace | agent), the guard, and the reason string — on one sweep. Not a
second copy of `terminalizeSession`. Size the slice as a real refactor of a
self-rescheduling batched sweep, and regression-test that the workspace-pause
path still writes `workspace_paused`.

**And it contradicts a live test.** `packages/backend/src/agent-sessions.test.ts:178-195`
currently deletes an agent and then asserts its session still appears in
`listJobs({view:'active'})`. D16 overturns exactly that assertion. The
neighbouring assertions — that attribution survives deletion — stay true and must
stay green.

### Sharp edges (awareness only)

- **SE-1 — D10 costs 2 requests per agent on the rail.** Ten agents is twenty
  round-trips. Fetch lazily per card with a long `staleTime`, reserve the role
  line so nothing shifts when it lands, and degrade silently when a read fails.
- **SE-2 — skill edits need checked-in codegen.** `packages/skills-registry/README.md`:
  generated source must be unchanged when codegen reruns without an authored-file
  change. Editing `manage-agents/SKILL.md` without rerunning it fails the gate.
  Good news: skills ship as API-served bytes installed by the gateway — **no image
  rebuild**, so D7 lands with an ordinary deploy.
- **SE-3 — the Duet card's "Workspace Apps" strip changes meaning.**
  `agents-workspace.tsx:336` maps *all* apps today; after D2a, apps inside an
  agent folder move to that agent's card and the Duet strip shows only root-level
  apps. Intended and user-visible, and it breaks `agents-workspace.test.tsx`.
- **SE-4 — `driveTabForPath` must learn the new route.** The `agents` tab regex
  is `/^\/w\/[^/]+\/(?:sessions|apps)(?:\/[^/]+)?\/?$/`
  (`apps/web/spa/drive/drive-routes.ts:13`). Miss it and the tab renders
  unselected on every agent detail page.
- **SE-5 — two locales.** `apps/web/messages/en/app.json` and `es-419` both need
  every new key, and `*-spanish` baselines already exist, so the roster needs one.

### D17 — picker eligibility · **decided**

The composer picker offers the default agent plus every enabled agent with a
healthy anchor. Agents that are `disabled` (`disabledAt`) or `broken`
(`anchorState`) are **excluded from the picker and have no New-session button**,
but stay visible in the roster with their status pill and reason — a broken
anchor means the folder is not there, so the `cwd` would point at nothing.

---

## Landed after this walk

The walk read `staging` at `e97a061a`. Before the plan was pushed, staging gained
the **orphaned-anchor** feature (`e3c01aa8`), which changes two facts this map
asserts:

- `AnchorStateSchema` is now `['active', 'broken', 'orphaned']`. Every projector
  must handle the third value exhaustively, though `orphaned` is unreachable for a
  live agent row — an agent row *is* a live consumer, so its anchor is `active` or
  `broken` (slice 04).
- Deleting an agent now orphans its anchor rather than leaving it, and
  re-registering the same folder **adopts** that anchor with the same `anchorId`.
  Per-agent memory therefore resurrects on delete-then-recreate, which is what
  makes D16's terminate-on-delete cheap: deletion is not destruction (slice 02).

Neither changes a decision; both change what the implementing slices must handle.

**And one in-flight change corrected a mechanism.** As of 2026-07-21 a concurrent
branch is reworking session deletion to be gateway-first and fail-closed: a new
`DELETE /v1/agent/sessions/:id` → `controller.discard()` that kills the runner,
cancels its timers, drops its buffer, and writes a durable tombstone; the API
returns 502 and deletes nothing when the gateway is unreachable.

Reviewing it exposed a real defect in D22's mechanism as this map first stated it.
"Reuse the workspace-pause sweep" covers the **control plane only**. Pause is
Convex-only because the VM is going away; an agent deletion leaves the VM up, so a
Convex-only sweep strands live runners that keep relaying into sessions the
database already calls interrupted. D16 stands unchanged — deleting an agent stops
its work — but the mechanism is now explicitly **two halves**: Convex sweep for
state, gateway teardown for the process. See slice 02.

Re-check this section against `git log origin/staging` and `git status` before
starting — this spec's backend neighbours are moving underneath it.

## Confirm before coding

Runtime facts no amount of reading settles. Both gate the entire backend rung and
are written **red first** in slice 01.

1. **`q.eq('agentId', undefined)` returns exactly the root sessions from the new
   index**, with stable pagination across a page boundary and no attributed rows
   leaking in (L2). The default card is the most-used surface in the product and
   it rests entirely on this.
2. **`search_sessions` accepts `agentId` as a sixth filter field** and composes
   with the existing four (L1).

Everything else the walk left open has since been closed by the drafting fan-out
and verified against the code — see D19–D22 in the landmine cards. The status
module's file name remains genuinely delegated (D12).

## Out of scope (unchanged)

`agent.json.triggers` auto-session-creation. A dedicated "deleted agents"
section in the roster (D16). In-app editing of `AGENTS.md` / `agent.json` (D4).
