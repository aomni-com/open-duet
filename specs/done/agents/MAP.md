# Agents — four-quadrant map

Status: exploration complete, 2026-07-21 (`explore-unknowns` walk). This is the
binding decision record; a build plan derived from it should treat the ledger
below as givens. Where a later slice conflicts with a detail here, the slice
wins — but the *decisions* (who owns what, what crosses a share) do not get
re-litigated without saying so.

> **The build plan now lives in [`README.md`](README.md)** (six slices, written
> 2026-07-21 from three parallel drafts). This ledger remains the *why*; the
> README is the *how*. The "Implementation prompt" and "Tweakable plan" sections
> at the bottom of this file are **superseded** by the README — follow the slice
> files, not those sections. Two build refinements the README owns that this map
> predates: (a) the gateway resolves agent eligibility from a **projected
> `agentId` on the VM anchor**, not `anchor.kind` (a replica at an exact share
> root reuses the `share-mount` anchor); (b) session **attribution** — the
> `agentSessions` row stamps `agentId`/`agentName` so Jobs can show which agent a
> session came from (added per user request after the walk). The deferred web UI
> is [`../agents-ui/README.md`](../agents-ui/README.md).

## Outcome in one paragraph

An **agent** is an anchored drive folder (anchor `kind:'agent'` + an `agents`
Convex row, mirroring `apps`) that bundles a system prompt (`AGENTS.md`), its
own skills (`.agents/skills/`), its own apps, and a behavioral config
(`agent.json`) whose state-machine `mode` is *forced* on every session started
under it. **Nothing new is invented at the runtime layer** — the upstream
`@duetso/agent` runner already derives prompt and skills from the session `cwd`
and already accepts a forced `mode` object on its start command; Duet simply
starts sending them. A session belongs to an agent by the **nearest agent-anchor
ancestor of its `cwd`** (default agent = drive root = no ancestor). Memory is a
**per-agent SQLite file outside the drive** (`~/.duet/agents/<anchorId>/memory.db`),
so it never syncs and cannot leak on a share. Agents share like folders; accept
**materializes a replica row** on the same convergence rule shared-apps uses, and
the recipient runs it on their own VM with fresh memory.

---

## 1. Known knowns — settled ground (cited)

**The load-bearing find: most of the mechanism already exists, keyed on `cwd`.**
- Upstream skills come from an **ancestor walk of `cwd`**:
  `<ancestor>/{.duet,.agents,.claude}/skills` for every ancestor, then global
  `~/…` roots (`@duetso/agent/dist/src/turn-runner/skills.js:9,26-39`).
- Upstream system prompt reads `AGENTS.md` relative to `cwd`
  (`.../skill-context.js:99-116`); RPC accepts `--system-prompt-files`
  (`.../cli/rpc.js:252-352`).
- Duet already threads `cwd` end to end: validated drive-relative
  (`packages/contract/src/agent/index.ts:707-728`), persisted immutably on the
  session (`schema.ts:725`, field at `:755`), carried through the gateway ledger,
  resolved with symlink-escape rejection (`process-runner.ts:301-317`).
- **The gap is product-side:** the web app never sends `cwd` — it only displays
  it (`apps/web/spa/routes/sessions.tsx:856`). Every UI session runs at drive
  root today. `cwd` is currently an API-only capability.

**Forced mode needs no upstream change.**
- `turn-runner.js:448`: `const mode = command.mode ?? this.config.mode ?? "auto"`.
  A `mode` object forces a state machine (`:1757` bootstraps a session from it);
  `'agent'` disables state machines, `'auto'` lets the agent choose.
- The start command already reserves the field: `AgentTurnStartCommand.mode?`
  (`packages/gateway/src/runner/protocol.ts:8-13`). The coordinator sends only
  `{type:'start', state?, mcpServers?}` and never populates `mode`
  (`coordinator.ts:341-348`). Injecting it is a one-site change.

**Drive / state.**
- `DRIVE_ROOT_PATH=/home/synthetic-user/drive`, `DUET_STATE_DIR_PATH=/home/synthetic-user/.duet`
  (`packages/contract/src/drive/index.ts:1-2`). Workspace = VM, 1:1.
- `~/.duet` is outside the drive, unreachable via the files API, excluded from
  the whole-drive mirror, **but included in the workspace archive**. Train
  upload/job state, `skill-releases/`, and `cli-rail/` are excluded, while
  completed Train provenance archives are preserved (`vm/archive.ts`), so
  per-agent memory and its inspectable corpus survive reprovision.
- **`.duet` is a reserved path segment everywhere.** `normalizeDrivePath`
  rejects any component named `.duet` (`drive/index.ts:32-34`) → a `.duet/`
  folder inside an agent would be invisible/unwritable through files API, MCP,
  and the web browser. `.agents/` and `.claude/` are **not** reserved and are
  accepted by the upstream walk — hence the in-folder convention is `.agents/`.

**Memory.**
- One `memory.db` per VM at `~/.duet/memory.db` today = **per-workspace, shared
  by all members** (not per-user, not per-session). `sessionId` is a tag, not a
  partition (`packages/contract/src/memory/index.ts:28`). The schema/retrieval
  live inside the out-of-repo CLI; Duet's only knob is `--db <path>`
  (`process-runner.ts:284-295,37-38`).

**Sharing.**
- Share = anchor + Convex `shares` row (`schema.ts:462-521`); bytes replicate via
  Syncthing over the sync-tunnel. Ignore floor
  `['**/.git','(?d)**/node_modules','.duet-anchor','**/.duet-anchor']`, additive
  and unremovable (`packages/contract/src/shares/index.ts:22-37`). A share syncs
  **only its subtree** — root-level files do not cross.
- Apps in a shared folder already propagate: accept materializes real `apps`
  rows on the recipient's VM via one convergence rule,
  `reconcileReplicasForOriginApp` (`domains/apps/replication.ts:73`).

**In-VM registration seam (what the authoring skill mirrors).**
- The in-VM agent registers an app via the **public REST API**
  `POST $DUET_API_URL/v1/ws/{slug}/apps` with `$DUET_API_KEY`
  (`skills-registry/skills/build-apps/SKILL.md:56-73`).
- That key is a real `duet_sk_` workspace key scoped `ai`+`apps`
  (`domains/apiKeys/model.ts:588-593`), minted server-side and injected into the
  agent env (`model-credentials.ts`, `runtime/http.ts:693-713`, `vmSync.ts:526`).
- Anchor **row** is created Convex-side inside `registerApp` via
  `getOrCreateAnchorForPath(kind:'app')` (`domains/apps/model.ts:90-99`,
  `domains/anchors/model.ts:657-681`); the **`.duet-anchor` marker file** is
  written gateway-side by the anchor reconciler from the sync payload
  (`gateway/src/routes/anchors.ts:264,285-292`).

**State machines are shipped, not planned.**
- `specs/done/agent-session-continuity/` records the shipped rationale. A
  session with a `stateMachine` **is** a Job; `jobView` derived at
  `domains/agentSessions/events.ts:396-399`.
- State kinds: `agent`, `script`, `poll`, `timer`, `park`, `terminal`
  (`@duetso/agent/dist/src/types/state-machine.d.ts:249-391`). `agent` states
  carry `allowedSkills` (per-state skill allowlist), and `model`/`thinkingLevel`
  are documented as **"set by the user through the UI"** — deliberately hidden
  from the orchestrating model. `agent.json` is exactly that UI's output.

## 2. Known unknowns — decision ledger

| # | Question | Decision | Closed by |
|---|----------|----------|-----------|
| 1 | Where does non-default agent memory live / how partitioned? | **Separate SQLite per agent, outside the drive:** `~/.duet/agents/<anchorId>/memory.db`, passed via the existing `--db`. Zero upstream change; physically cannot leak on share; rides the archive. Accepted cost: **no cross-agent recall** (the default agent cannot recall another agent's memories). | Example User |
| 2 | What makes a folder an agent? | **Anchor `kind:'agent'` + an `agents` Convex row**, mirroring `apps`. Config *content* lives as files in the folder so it syncs on share; the anchor owns path identity (survives rename/move). | Example User |
| 3 | How strictly does the state machine constrain sessions? | **Forced when `agent.json` defines a mode; `auto` otherwise.** The default agent is `auto` (status quo). | Example User |
| 4 | Must an agent live under `agents/`? | **No — anchored anywhere, like apps.** `agents/` is the creation default only. Avoids overriding the recipient's share `mountPath`. | Example User |
| 5 | What does accepting a shared agent create? | **A replica `agents` row** tagged `sourceShareId`/`sourceAgentId`, converging by the same rule as app replicas; runs on the recipient's own VM, own credits, **fresh empty memory**. Recipient is **both technical and non-technical** (zero-intervention happy path, like apps). | Example User |
| 6 | How does a session know its agent? | **Derive from `cwd` — nearest agent-anchor ancestor wins**, none = default agent. No new request field. Resolution is **gateway-local** (see #9 / D-A). | Example User |
| 7 | Prompt file name | **`AGENTS.md`** (standardized), passed via `--system-prompt-files` resolved to the **agent boundary**, not `cwd`. (Overrode an initial `duet.md` recommendation.) | Example User |
| 8 | Prompt inheritance across the agent boundary | **Stops at the boundary — an agent's `AGENTS.md` replaces, never layers.** Makes a shared agent reproducible regardless of the recipient's root prompt. | Example User |
| 9 | Skills inheritance across the boundary | **Inherit — deliberately.** Every sub-agent gets ancestor skills via the upstream walk; this is intended (a skill is a capability, a prompt is an identity). `allowedSkills` per state is the narrowing knob. **Asymmetry is by design:** prompt replaces, skills accumulate. | Example User |
| 10 | Can the default agent be customized? | **Yes — `drive/AGENTS.md` + `drive/.agents/skills`.** The drive root *is* the default agent's folder; the ancestor walk already reaches it. Editable via files API/MCP/web. | Example User |
| 11 | Who authors `agent.json`? | **The agent itself**, taught by a new default **`manage-agents` skill** (ships in the skills-registry bundle) documenting the register endpoint, the `agent.json` schema, and how the state machine works. Primary path = the default agent configuring other agents. | Example User |
| 12 | Config file shape/name | **One generalized `agent.json`** at the agent root: `{ mode: <state-machine def, forced when present>, triggers: [] (reserved for future auto-session-creation) }`. Not the rejected v1 manifest pattern — identity stays on the anchor; this is pure synced content. | Example User (decide-and-inform) |
| 13 | Malformed / missing `agent.json` | **Missing → `auto` (valid persona agent). Malformed → `auto` + a warning event AND an appended line to the standardized error log (#15).** Never blocks a session. | Example User |
| 14 | Consent for running a shared agent's shell | **No disclosure — accepted**, consistent with shared-apps ledger #11. Accepting + running a replica agent silently executes its `script`/`poll` shell on the recipient's VM. | Example User |
| 15 | Log convention | **A general per-agent log inside `~/.duet`**, co-located with memory: `~/.duet/agents/<anchorId>/logs.log` (default agent: `~/.duet/logs.log`). **Outside the drive, not synced** — same locality as memory, so a shared agent's logs stay recipient-local. Not errors-only — general logs; `agent.json` parse failures (#13) land here. **Capped at 10k lines** (rolling truncation). Agents on the same VM read each other's logs via the filesystem (read-anywhere) to **debug each other**; the `manage-agents` skill teaches tailing them. | Example User |
| 16 | Default agent representation | **Absence of an agent, not a seeded row.** No agentId ⇒ drive-root `cwd`, `~/.duet/memory.db`, `auto`. No seed data, no migration; every existing session stays valid. | decided + informed |
| 17 | Double-share (agent to A, one app inside it to B) | **Accepted known limitation — NOT supported, and not a deferred TODO.** Sharing an agent and separately sharing an app *nested inside it* to a different user requires two **overlapping** share roots, which `assertLinkedRootDoesNotNest` (`domains/shares/model.ts:98,595-660`) forbids — enforcing the real transport constraint that **Syncthing send folders cannot nest**. The per-(app × share) replica fan-out itself works (`apps/replication.ts:88-120`); the block is the overlapping *share roots*, not the replica rule. Escape hatch if ever truly needed: an app-share primitive decoupled from folder sync — explicitly out of scope. | Example User |

## 3. Unknown knowns — extracted context

- **An agent is a *process or a persona*, and both are first-class.** With a
  `mode` it's a forced repeatable process; without one it's a persona (custom
  prompt + skills + memory, `auto` behavior). The config is optional precisely so
  both fit one model. (Extracted from #3 + #13.)
- **Skills accumulate, prompts replace — and that split is the point.** The user
  corrected mid-walk: skills *should* inherit down the tree; a prompt is an
  identity you don't want a recipient's root overwriting. This turned an apparent
  landmine (the unconditional ancestor walk) into a confirmed feature (#8/#9).
- **The default agent is the *setup surface* for every other agent.** "Owns the
  whole drive" is literal — it's the drive-root session, and it authors other
  agents' `AGENTS.md`/`agent.json` through the files API + `manage-agents` skill.
- **Agents debug agents.** The per-agent log convention (#15) exists so a
  supervising agent can diagnose a failing one — an operational model where the
  fleet is partly self-maintaining, not just human-maintained. Logs live beside
  memory in `~/.duet` (local, unsynced), so this is same-VM introspection, not a
  cross-share capability.
- **App-sharing granularity has a hard ceiling (#17).** The user wants an app
  inside a shared agent to be independently shareable to a second person. The
  architecture gives per-(app × share) replicas for free, but *overlapping share
  roots* are a wall (Syncthing can't nest). Accepted as a limitation — the taste
  is "clean single-share model over contortions to beat the transport."
- **No sessionless agents (corrected the map).** Every state machine runs *inside*
  a session; `timer`/`poll`/sleep survive via the shipped durable wake rail
  (agent-session-continuity), but an agent does nothing until a session exists.
  Automatic session *creation* is future, and its config is the reserved
  `agent.json.triggers`.
- **Recipient is mixed (technical + non-technical), like apps** → the one genuinely
  new product surface (an agent picker that sends `cwd`) must work with
  zero recipient intervention in the happy path.

## 4. Unknown unknowns — landmine cards

1. **VM key can't create agents (capability gap).** Injected key is `ai`+`apps`
   only (`apiKeys/model.ts:588-593`). Authoring dies at 403 until an **`agents`
   capability** is added to `vmModelScopes` + a `POST /v1/ws/{slug}/agents` route
   + `registerAgent` mutation exist. → **Build item.**
2. **`mode`/memory resolution had no owner.** → **Closed (D-A): gateway-local,
   keyed by `anchorId`.** At spawn the gateway finds the nearest agent-anchor
   ancestor of `cwd` from its own anchor snapshot, derives
   `~/.duet/agents/<anchorId>/memory.db`, reads `<agentRoot>/agent.json` for the
   forced mode, and passes `--system-prompt-files <agentRoot>/AGENTS.md`. Launch
   spec stays `.strict() {cwd, gatewayModelId}`; mode is always the freshest
   on-disk config; no agentId needed at spawn.
3. **Shared agent = arbitrary shell on the recipient's VM** (`script`/`poll`
   `bash -c`). Bigger gun than a single app `command`. → **Closed (D-C): no
   disclosure, accepted** (consistent with shared-apps).
4. **Malformed/missing `agent.json` fail policy.** → **Closed (D-B): missing →
   `auto`; malformed → `auto` + warning event + error-log line.** Never blocks.
5. **Sync-lag race on create-then-start.** Anchors arrive on the 5s sync; a
   register-then-immediately-start can resolve to the default agent (wrong
   memory/mode). → **Sharp edge; fix folded in:** inline anchor push on register,
   mirroring apps' `pushAppsReconcile`.
6. **A shared agent's skills are portable only if inside the folder.** A share
   syncs only the subtree, so the origin's *root* skills don't cross while the
   recipient's *own* root skills do. → **Sharp edge;** `manage-agents` must
   instruct: put an agent's own skills in `<agent>/.agents/skills`.
7. **New argv `--system-prompt-files` isn't passed today** (`process-runner.ts:281-299`).
   Must be added, resolved at the boundary, and skip gracefully when absent. Also
   the mechanism that keeps a non-agent repo's `AGENTS.md` inert. → **Build item.**
8. **Anchor kind `'agent'` ripples** across the anchor reconciler (markers),
   `renameDecision`, share `anchorTransitions`, and the files-browser projection
   (`apps-in-file-view`), and must be a **compatible kind alongside `share-root`**
   in `getOrCreateAnchorForPath`. → **Build item, broad but mechanical.**
9. **Per-agent state-dir lifecycle unowned.** `~/.duet/agents/<anchorId>/` holds
   both `memory.db` and `logs.log`. Gateway must `mkdir -p` before spawn; on agent
   delete, **leave the dir** (orphaned but harmless; supports un-delete). Archive
   already includes it (durability free). → **Decide-and-inform.**
10. **Log-cap enforcement (#15).** `logs.log` is capped at 10k lines with rolling
    truncation — needs an owner (gateway-side rotation on append, or a size check
    before write). Silent unbounded growth on a 2 GB VM is the failure mode. →
    **Build item.**

## Builder must confirm before coding

- [ ] Upstream `--system-prompt-files` honors an **absolute** path and **skips
      cleanly when the file is missing** (the persona-agent-with-no-`AGENTS.md`
      case). Scan says absolute names are honored verbatim; verify no-file is not
      a hard error.
- [ ] The `duet` CLI **creates the `--db` parent dir** or the gateway must
      `mkdir -p` first (card 9).
- [ ] On **resume**, the coordinator passes `state` (checkpoint) and the runner
      ignores `mode` (`turn-runner.js:450` uses `command.state` when present) —
      confirm forced `mode` is sent **only when `checkpoint === undefined`**, so a
      resumed session keeps its running machine. Mode is **bound at session
      start**, not live-updated (consistent with the "resolved model is
      prompt-bound state" invariant).
- [ ] The gateway anchor snapshot is **reachable from the coordinator at launch**
      to run the nearest-ancestor walk (D-A).
- [ ] `agents` capability added to the **VM-minted** key
      (`vmModelScopes`), not just the public scope grammar.
- [ ] Files-browser projection (`apps-in-file-view`) renders an `agent` anchor
      sensibly (or agents show as plain folders).

## Contract deltas (the seam, summarized)

```
// New Convex table — deliberately mirrors `apps` (schema.ts:418-446)
agents: defineTable({
  workspaceId:   v.id('workspaces'),
  anchorId:      v.id('anchors'),          // kind:'agent'; owns path identity
  slug:          v.string(),
  name:          v.optional(v.string()),
  icon:          v.optional(v.string()),   // relative path, like apps
  sourceShareId: v.optional(v.id('shares')),   // set = replica
  sourceAgentId: v.optional(v.id('agents')),
  disabledAt:    v.optional(v.number()),
  disabledByUserId: v.optional(v.id('users')),
  createdAt: v.number(), updatedAt: v.number(),
})
  .index('by_workspace', ['workspaceId'])
  .index('by_anchor', ['anchorId'])
  .index('by_source_agent', ['sourceAgentId'])   // origin-mutation fan-out
  .index('by_source_share', ['sourceShareId'])    // revoke cleanup

// anchors.kind gains 'agent' (schema.ts:399-417); compatible with 'share-root'.

// Public API (mirrors apps):
POST   /v1/ws/{slug}/agents            { path, slug, name?, icon? }   scope ws:{slug}:agents
GET    /v1/ws/{slug}/agents
PATCH  /v1/ws/{slug}/agents/{slug}
DELETE /v1/ws/{slug}/agents/{slug}

// VM-minted key scope gains `agents` (domains/apiKeys/model.ts:588-593).

// In the drive, inside an agent folder (sync on share):
<agentRoot>/AGENTS.md                 // system prompt (boundary-scoped)
<agentRoot>/agent.json                // { mode, triggers:[] }
<agentRoot>/.agents/skills/*/SKILL.md // own skills (accumulate down-tree)

// OUTSIDE the drive — per agent, keyed by anchorId; never syncs, in the archive:
~/.duet/agents/<anchorId>/memory.db   // per-agent memory
~/.duet/agents/<anchorId>/logs.log    // general log, 10k-line cap (#15)
// default agent (drive root): ~/.duet/memory.db + ~/.duet/logs.log

// Gateway spawn (process-runner.ts argv) gains, when cwd resolves to an agent:
--system-prompt-files <agentRoot>/AGENTS.md
--db ~/.duet/agents/<anchorId>/memory.db     // replaces the boot constant
// + coordinator injects `mode` into the start command when checkpoint===undefined
```

## Tweakable plan (sorted by likelihood of tweaking, not execution order)

1. **`agent.json` shape and the `manage-agents` skill copy** — most likely to
   iterate; the schema and what the skill teaches will move as real agents get
   built. Keep `mode`/`triggers` split easy to change.
2. **Error-log path + format (#15)** — new convention; exact filename/rotation is
   a guess until agents actually debug each other.
3. **Agent picker UI (the one new product surface)** — where it lives (session
   composer vs file browser) and how it sends `cwd`. Non-technical-recipient
   affordances (a "run" affordance for replica agents) live here.
4. **Malformed-config degradation (#13)** — `auto`+warn is the current call; could
   tighten to fail-closed if silent freeform proves harmful.
5. *Mechanical (trusted):* `agents` table + indexes + capability + REST routes,
   `kind:'agent'` through anchor/rename/share/projection, gateway-local
   nearest-ancestor resolution, per-agent `--db` + `--system-prompt-files` argv,
   inline anchor push on register, replica convergence rule cloned from
   `apps/replication.ts`, `mkdir -p` for the memory dir.

## Implementation prompt (SUPERSEDED — see README.md's six slices)

> The prose prompt below was the pre-plan kickoff. It is kept for provenance but
> is **superseded by [`README.md`](README.md)**; a fresh agent should start at
> `slices/01-backend-agents-and-attribution.md`, not from this paragraph.

> Implement the "agents" feature per `specs/agents/MAP.md` (binding). An agent is
> an anchored drive folder (`kind:'agent'` + an `agents` Convex row mirroring
> `apps`) bundling `AGENTS.md` (prompt), `.agents/skills/` (own skills),
> `agent.json` (`{mode, triggers}` — mode forced when present), its own apps, and
> `errors.log`. Memory is per-agent at `~/.duet/agents/<anchorId>/memory.db`,
> outside the drive. A session resolves to its agent by the nearest agent-anchor
> ancestor of `cwd` — **gateway-local**, keyed by `anchorId` (ledger #6/#9, D-A);
> default agent = drive root = no ancestor. Confirm the "builder must confirm"
> checklist first (esp. upstream `--system-prompt-files` missing-file behavior and
> the resume-vs-forced-mode ordering). Follow AGENTS.md: write-tests-first; reuse
> the shared-apps convergence rule (`domains/apps/replication.ts`) for agent
> replicas rather than re-deriving it; no migrations/compat (staging hard cut).
> Suggested slices: (1) `agents` table + `kind:'agent'` anchor + REST routes +
> `agents` VM-key capability; (2) gateway-local cwd→agent resolution driving
> per-agent `--db` + `--system-prompt-files`; (3) forced `mode` injection on fresh
> start (+ malformed→auto+error-log); (4) the `manage-agents` default skill;
> (5) share replica convergence for agents; (6) the agent picker UI that sends
> `cwd`. End with the live staging e2e per AGENTS.md.
