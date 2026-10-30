# Agent delegation — quadrant map

Agents cannot see each other. A session's system prompt lists its apps but not
its colleagues, so an agent asked to "get Research to do this" has to discover
the roster through the REST API, if it thinks to look at all.

This map settles what a session is told about the other agents around it, and
how the two of them hold a conversation. Walked 2026-08-08 with Example User; binding
input for `write-spec`.

> **The feature SHIPPED and the spec is closed; [`README.md`](README.md) is the
> rationale record.** This map is the exploration that produced it: read it for
> the walk's *why*. Sections 5, 6 and 7 below were superseded during the build
> and are kept for provenance; the build ladder itself is collapsed. Where the
> build corrected a decision here, the correction is written into the row.

**Shape in one line:** every session is told about the agents one layer below it
and the one agent directly above it, and delegation is a blocking wait that the
other agent answers by ending its turn with an `ask`.

---

## 1 · Known knowns — the settled ground

### The seam already exists

The gateway writes small generated prompt files per turn and passes each to the
runner as its own `--system-prompt-file`. Four exist today — the author's
`AGENTS.md`, `your-apps.md`, `default-session.md`, `parent-session.md` —
assembled in `packages/gateway/src/agents/agent-context.ts:389`. They are written
outside the drive so they never sync, never publish, and cannot be edited by the
agent they instruct. A fifth file needs no new machinery.

### Apps are the precedent, scoped by nearest agent

`groupAppsByAgent` (`packages/contract/src/agents/index.ts:233`) buckets each app
to its nearest enclosing agent; the root scope receives only apps under no agent.
The roster follows the same rule for agents.

### Two rails reach another agent, both already shipped

| Intent | Route |
| --- | --- |
| Talk to an agent | `POST /v1/ws/{ws}/agents/{slug}/sessions/default/messages/wait` |
| Hand off a watchable job | `POST /v1/ws/{ws}/agent/sessions/{parent}/sessions/wait` with `cwd` |
| Answer a question it asked | `POST /v1/ws/{ws}/agent/sessions/{id}/answer/wait` |

Registered in `apps/api/src/routes/session-waits.ts:57-76` and
`routes/default-session.ts:40-63`. The default-chat alias is lazily created and
404s for a disabled or broken agent (`default-session.ts:78`).

### The sandbox can already call all of it

`$DUET_API_KEY` is a `system_vm` key (`domains/apiKeys/model.ts:521`) whose scopes
include `sessions` and `agents` (`model.ts:826`). Authorship: a `system_vm` caller
is `{kind:'system'}` unless it passes `sourceSessionId`, which makes it
`{kind:'session', sessionId}` (`apps/api/src/session-sender.ts:29`).

### Nesting is supported, and already relied on

Confirmed by the territory, not assumed:

- Registration checks only exact-path uniqueness and anchor-kind compatibility
  (`domains/anchors/model.ts:703`, `domains/agents/model.ts:63`). No
  ancestor/descendant check exists.
- `resolveNearestAgent` picks the **deepest** match
  (`contract/src/agents/index.ts:204`); the shipped spec states it as an
  invariant (`specs/done/agents/README.md:100`).
- Train already walks the ancestor agent chain to list inherited memory stores
  (`packages/gateway/src/train/agent-scope.ts:80`).

Consequences: `AGENTS.md` does **not** layer — the nearest agent's file replaces
everything above it (`agent-context.ts:360`) — while skills *do* inherit down the
tree. Nesting is forbidden only for **share roots**, because Syncthing
send-folders cannot nest (`domains/shares/model.ts:669`).

### The envelope already carries the asker

`renderRunnerInput` (`domains/agentSessions/runnerEnvelope.ts:103`) wraps every
delivered input in an element named for the sender kind, with identity
attributes resolved fresh at composition time:

```xml
<session_message seq="12" timestamp="2026-08-08T…Z" session_id="k97a…">…</session_message>
```

---

## 2 · Known unknowns — the decision ledger

Every question named during the walk, its answer, and who closed it. Nothing
here is open.

| # | Question | Decision | Closed by |
| --- | --- | --- | --- |
| D1 | Who appears in a session's roster? | Nearest-enclosing: the agents one layer **below**, plus the one agent directly **above**. Root has no parent entry. "One layer" is measured in agents, not folders — `projects/a/b/scout` is root's direct child if no agent sits between. | Example User |
| D2 | Which rail does the roster teach? | Both. Talking to an agent → its home chat by slug. Handing off a watchable job → spawn a session at its `cwd`. | Example User |
| D3 | How does the other agent ask a question back? | It ends its turn with an **`ask` terminal**, which resolves the waiter's request. It must never message a session that is waiting on it. | Example User |
| D4 | Are not-yet-onboarded children listed? | Yes, flagged "awaiting onboarding; ask the user to set it up before delegating". **CORRECTED during planning:** the flag must use `agentIsLocked` — `config.readable && config.onboarding !== undefined && agent.onboardedAt === undefined` (`apps/web/spa/drive/agent-onboarding-projection.ts:5`), moved into `@repo/contract`. Keying on `onboardedAt` alone, as originally written, would flag nearly every working agent, since that field stays `undefined` forever for any agent with no `agent.json`. Example User confirmed the fix and named "hide locked agents entirely" as the fallback if the `agent.json` read proves costly. | Example User |
| D5 | Does the envelope name the sending agent? | Yes — add `agent_slug` and `agent_name` beside the existing `session_id`. | Example User |
| D6 | How is root addressed? | Move it to `/v1/ws/{ws}/agents/root/sessions/default/…` and **delete** the four `/agent/sessions/default*` routes. | Example User |
| D7 | Does the block inline curl, or point at skills? | Inline the full recipes, mirroring `your-apps.md`. | Example User |
| D8 | What shape is the reply instruction? | A **rule**, not a pointer: read `session_id` off the envelope you were handed. `parent-session.md` can name one fixed session because lineage is fixed; a home chat has many correspondents over its life. | Claude |
| D9 | How do slug and name reach the gateway? | A new `agents: GatewayAgentConfig[]` array on `VmSyncResponse`, mirroring `apps`. **Not** new fields on `GatewayAnchor` — that type is the filesystem anchor, and `agentId` is already a bleed. Same Convex read either way (`anchors/model.ts:625`). | Claude |
| D10 | Row order and cap? | Sorted by slug, cap 30, overflow line pointing at `GET /v1/ws/{ws}/agents` — identical to the apps block. | Claude |
| D11 | Roster in onboarding sessions? | No, mirroring apps (`agent-context.ts:371`). An onboarding interview's one job is to stay put. | Claude |
| D12 | Does a row carry a description? | No. There is no field on the agent row to source one from. | Claude |
| D13 | The agents map draws every agent flat — what closes the gap? | A follow-up slice in this spec: the ring shows direct children only; a nested agent is reached by zooming into its parent. | Example User |
| D14 | What does the journey exercise? | Root → a mock agent whose `AGENTS.md` instructs it to always ask one question back → root answers → completion. | Example User |
| D15 | Who reads the rendered block? | Model only. Prose can be terse and imperative; it does not need to explain itself to a human. | Example User |
| D16 | What is done? | The staging journey green. | Example User |
| D17 | Does the D6 route deletion carry a compat window? | No. Hard cutover: the four old routes and every caller move in one slice. No shim, no deploy-order dance. | Example User |

### Found during planning, after the walk

Three facts the walk missed, surfaced by the parallel drafters and verified
against the code. Each is written into the owning slice; recorded here so the
map does not read as complete when it was not.

- **`parent-session.md` currently instructs the exact deadlock D3 forbids** — it
  tells every child to reach its parent via `/messages/wait` with `follow_up`
  (`packages/gateway/src/agents/parent-session-prompt.ts:25`). Slice 05 narrows
  it to the idle-parent case.
- **Root has no `agents` row**, so a direct child of root cannot name its parent
  unless the wire carries root explicitly. `GatewayAgentConfig` is a
  discriminated union with a `root` member (slice 01); envelope identity comes
  from `workspaces.duetName` (slice 02).
- **There are two prompt-assembly sites**, not the one this map cited:
  `contextForAgent` at `agent-context.ts:389` and `defaultAgentContext` at
  `:326`. Wiring only one silently leaves *root* sessions with no roster.

Citation corrections to this map: `renderRunnerInput` is at
`runnerEnvelope.ts:119` (`:103` is `renderElement`); `listForVmImpl` starts at
`anchors/model.ts:612` with the disabled-agent drop at `:631`; the flat map ring
is at `use-workspace-map.ts:151`.

### Closed by the territory

| # | Question | What the code answered |
| --- | --- | --- |
| T1 | Can an agent folder contain another agent folder? | Yes — see §1. Deepest wins; memories inherit up the ancestor chain; `AGENTS.md` does not layer. |
| T2 | Does the sub-agent know which session asked? | Yes, when the caller passes `sourceSessionId`. Without it the envelope degrades to `<system_message>` with no identity at all. |
| T3 | Does the roster go stale in a long-lived home chat? | No. Every terminal kills the runner (`coordinator.ts:206`), so each turn regenerates the file from current gateway state. |
| T4 | Can a sandbox session call these routes? | Yes — `sessions` and `agents` scopes are on the VM key. |
| T5 | Does moving a session's cwd re-home it? | No. `agentAnchorId` is stamped once at creation (`agent-context.ts:248`). |

---

## 3 · Unknown knowns — what got extracted

- **Model-only consumer.** Nobody reads a rendered `your-agents.md` as
  documentation. This licenses terse, imperative prose and removes any need for
  explanatory framing — but raises the bar on unambiguity, since a
  misunderstanding surfaces as a wrong API call, not a confused reader.
- **Staging journey is the first environment.** There is no real workspace with
  nested agents today. The nested-scope prose is therefore written against the
  journey's own fixture rather than observed usage — worth revisiting once a
  nested agent exists in anger.
- **The mock agent is a fixture, not a real persona.** Example User's suggestion: give
  the journey an agent whose instructions are "always ask one question back".
  That makes the `ask` leg deterministic instead of hoping a real agent happens
  to need clarification.
- **Root is already an agent everywhere except one URL.** `PATCH /agents/root`,
  `?agentId=root`, `ROOT_AGENT_SCOPE` in the picker, the map centre, and the job
  filters all spell it. `defaultChatAgentSlug()`
  (`apps/web/spa/sessions/default-chat.ts:39`) exists *only* to translate
  `ROOT_AGENT_SCOPE → null` for the odd route — D6 collapses it.
- **The one-layer rule was load-bearing beyond scoping.** It makes the A→B→C→A
  message cycle unreachable, because C can never name A. See L5.

---

## 4 · Unknown unknowns — landmine cards

### L1 · `AgentNameSchema` permits any character — sharp edge, must handle

`AgentNameSchema` is `z.string().trim().min(1).max(32)` with **no charset
restriction** (`contract/src/agents/index.ts:17`). A user-chosen name containing
a backtick, newline, or `#` lands verbatim in a markdown system-prompt block and
can corrupt or hijack it. `your-apps-prompt.ts:82` already strips `[\r\n\t\`]`
from app names for exactly this reason. **The roster must sanitize identically.**
Missing this is invisible until someone names an agent something clever.

### L2 · The map contradicts the roster — decided (D13)

`use-workspace-map.ts:132` builds one flat ring from `agents` verbatim. A nested
Scout renders as a peer of its parent on root's ring while being absent from
root's roster. Closed by a follow-up slice bringing the ring to one layer.

### L3 · The shipped apps block lies about its own freshness — finding beyond the feature

`your-apps.md` opens with *"a snapshot of the apps available to this session when
the session started"* (`your-apps-prompt.ts:28`). Per T3 the file is rewritten
every turn from live state. The sentence teaches models the list is stale when it
is not, and copying the phrasing into the roster would propagate the error.
**Fix the apps wording in the same pass.**

### L4 · Reusing `groupAppsByAgent` for agents returns empty rosters — must handle

`resolveNearestAgent` counts an exact path match as a hit
(`contract/src/agents/index.ts:216`). Harmless for apps, since an app anchor can
never occupy an agent anchor's path (`agents/model.ts:75`). Fatal for agents:
every agent is its own nearest agent, so every bucket collapses and every roster
renders "no agents". Needs a self-excluding grouping helper. Fails silently.

### L5 · One-layer scoping is the deadlock guard — sharp edge, keep it

`follow_up` waits for the recipient's current turn to end. A session blocked in
a foreground wait never ends its turn, so messaging a blocked waiter hangs both
sides on 202 forever. Two things prevent it: D3's rule (answer with `ask`, never
a message), and D1's scoping, which makes distant cycles unaddressable. The
`ask` terminal chains correctly up a deep tree — Scout asks, Research's wait
returns `ask`, Research either answers or ends its own turn asking, and root's
wait returns `ask`. **Any future widening of D1 reopens this.**

### L6 · A nested agent and its parent can never both be shared — sharp edge

`assertLinkedRootDoesNotNest` (`domains/shares/model.ts:669`) throws
`Linked roots cannot contain each other`. Publishing Research to the marketplace
carries Scout inside it as ordinary files; Scout can never be shared separately
while Research is. Not a blocker here; a wall for anyone selling a nested bundle.

### L7 · `agentId` is dropped for disabled agents — sharp edge, free win

`listForVmImpl` omits `agentId` when the agent is disabled
(`anchors/model.ts:625`). Disabled agents therefore fall out of the roster with
no extra filtering — provided D9's new array applies the same rule rather than
inventing its own.

---

## 5 · Confirm before coding — RESOLVED, do not re-run

All four were verified during planning. Kept for the record; nothing here is
outstanding.

1. **Confirmed.** `defaultWait` routes through `runInitialWait` with
   `kind: 'initial_prompt'` (`session-waits.ts:264`) — create-and-wait in one
   call, and it accepts `sourceSessionId`.
2. **Refuted — the premise was wrong.** A `system_vm` key *does* carry a user:
   it is minted with the workspace's `createdByUserId`, and
   `authorizedSystemVmKeyPayload` always returns a populated `user`
   (`domains/apiKeys/model.ts:347`). `AuthPayload.user` is non-optional
   (`apps/api/src/shared.ts:108`). `assertReader` tolerates `internalKey`
   without an `actorId` anyway (`agentSessions/queries.ts:439`). Nothing to fix
   — and a sandbox agent can therefore *read* another agent's session state,
   not only write to it.
3. **Confirmed.** The durable terminal row carries `questions`
   (`contract/src/agent/index.ts:506`) and the wait returns that row verbatim;
   `staging-e2e-synthetic:127` already asserts on it.
4. **Confirmed.** `AgentAnswerRequestSchema` carries `sourceSessionId`
   (`contract/src/agent/index.ts:861`).

Found while confirming: `/v1/ws/{ws}/agents/root/sessions/default` currently
returns **500, not 404** — `getBySlug` runs `AppSlugSchema.parse('root')`
(`domains/agents/model.ts:461`) and `root` is reserved. Slice 03 opens on that
as its red test.

---

## 6 · Build plan — SUPERSEDED by [`README.md`](README.md)

> This was the walk's first-pass ordering. The build replaced it with an
> eight-slice risk-first ladder (now collapsed; the closed README records what
> survived). Kept only to show what the walk proposed before the drafting pass.

**Judgment calls first.** Everything below the line is mechanical.

1. **The prose of `your-agents.md`, per scope.** The deliverable itself. A
   rendered sample for all three scopes is in the walk's artifact; expect to
   iterate on wording once a real model reads it.
2. **The reply rule's phrasing.** One paragraph carrying L5. It must forbid
   messaging a waiter and name the deadlock as the reason — a rule without its
   reason gets reasoned around.
3. **The journey and its mock agent** (D14). An agent whose `AGENTS.md` says
   "always ask exactly one clarifying question before doing the work". Register
   in `packages/test-harness/src/staging-e2e-synthetic`.
4. **Root route unification** (D6) — one early return in
   `resolveDefaultSessionOwner`, then delete the four old routes, their four
   contract entries, `defaultChatAgentSlug`, and update
   `staging-e2e-synthetic:122`.
5. **Envelope fields** (D5) — `resolveCurrentModelSender` walks session →
   `agentId` → agent row; degrade to id-only for a deleted or cross-workspace
   agent, exactly as the app branch does. One caller (`delivery.ts:1034`).

---

6. `GatewayAgentConfig` + the `agents` array on `VmSyncResponse`, produced in
   `composeVmSyncResponse` and consumed as a closure on the gateway coordinator,
   mirroring `apps` end to end.
7. The self-excluding grouping helper (L4) in `contract/src/agents/`, beside
   `groupAppsByAgent`.
8. Name sanitization (L1), shared with `sanitizeAppName` rather than copied.
9. The apps-block wording fix (L3).
10. Follow-up slice: the map ring shows one layer (D13, L2).

---

## 7 · Implementation prompt — SUPERSEDED

> **Do not follow this.** It points at §5 and §6, both stale, and the feature
> has shipped — there is nothing to implement. [`README.md`](README.md) is the
> record.
