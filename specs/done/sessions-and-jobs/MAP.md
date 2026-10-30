# Sessions and Jobs — quadrant map

Session-owned state machines, a default session per agent, session lineage,
and two default skills that teach the API. Written 2026-07-31 from a quadrant
walk with Example User. Binding input for `write-spec`; this is the map, not the plan.

**The shape in one paragraph.** A state machine stops being a property of an
agent folder and becomes a property of a session, supplied at creation. Every
agent (and the drive root) gains one default session — the conversation the
user returns to — which is discouraged from running work machines and instead
starts *other* sessions for anything trackable or scheduled. Sessions record
who started them, so a child can interrogate its parent and the UI can show
lineage. None of this needs a new tool: the runner already has `$DUET_API_URL`
and a `sessions`-scoped `$DUET_API_KEY`, so two skills teach the REST calls.

---

## Quadrant 1 — Known knowns (the settled ground)

**Mode is already session-scoped in everything but the wire.**
`TurnState.mode` is `'agent' | 'auto' | StateMachineDefinition`
(`packages/contract/src/agent/index.ts:160`), sent exactly once on the `start`
frame and only when the session has no checkpoint
(`packages/gateway/src/agent-sessions/coordinator.ts:479-485`). Everything
after that resumes from the durable checkpoint. Today the only supplier is
`agent.json`'s `mode`, read per-anchor
(`packages/gateway/src/agents/agent-config.ts:12-41`).

**The launch envelope is the transport.** `GatewayRunnerInputRequest.launch`
is `.loose()` (`contract/src/agent/index.ts:760`) and frozen at session
creation by `mergedLaunch`
(`packages/gateway/src/agent-sessions/ledger.ts:728`) — correct for a value
that must survive wakes and crash recovery.

**"Session with a state machine" is already the definition of a job.**
`JobSummary = SessionSummary + jobView + relaySummary`
(`contract/src/sessions/index.ts:73`); `projectRelaySummary` (:222) derives the
ordered state path, `progress`, `activity`, `nextWakeAt`, `outcome`.
`GET /v1/ws/{slug}/agent/jobs` and `apps/web/spa/routes/jobs.tsx` are live.

**The credential and the URL are already in every runner.** Spawn env carries
`DUET_API_URL`, `DUET_API_KEY`, `DUET_SESSION_ID`
(`packages/gateway/src/runtime/http.ts:947-956`,
`packages/gateway/src/runner/process-runner.ts:341`); the VM key is minted with
`ws:{slug}:sessions|agents|apps|services`
(`packages/backend/convex/domains/apiKeys/model.ts:823`); `GET /v1/whoami`
yields the slug. Three shipped skills already use exactly this pattern
(`duet`, `manage-agents`, `publish`).

**One API for web and agent.** The SPA calls `/api/duet/ws/{slug}/agent/...`,
a thin proxy (`apps/web/app/api/duet/[...path]/route.ts`) onto the same `/v1`
handlers. `SessionSummary.status` (`running | ask | complete | interrupted |
sleep`) drives the web spinner (`apps/web/spa/status/entity-status.ts:24-30`)
and is honest, because terminal-means-terminal makes a live runner equivalent
to a turn actually running.

**Prompt layers regenerate every turn.** The system prompt is not part of the
checkpoint; the runner rebuilds it from `--system-prompt` /
`--system-prompt-file` at every `Agent` construction, and the gateway rewrites
the layer file atomically at every launch
(`packages/gateway/src/agents/agent-context.ts:162-176`). Since every turn is
a fresh spawn, injected layers are live per turn — but they sit in the cached
prefix, so volatile content costs a cache miss per turn.

**Idempotent per-agent session open already exists** as a pattern:
`openOnboardingSession` (`packages/backend/convex/domains/agentSessions/creation.ts`)
returns the existing row or creates one; `onboarding` is a structural equality
dimension on every index, never an after-the-fact filter
(`packages/backend/convex/schema.ts:989-994`).

---

## Quadrant 2 — Known unknowns (the decision ledger)

Every question closed by the user unless marked otherwise. None open.

| # | Decision | Closed by |
|---|---|---|
| D1 | Default session is **lazy open-or-create** — created on first open, not at agent creation | user |
| D2 | The default session stays in `auto` mode; machines are discouraged by prompt, not by removing the tool | user |
| D3 | A job **is** a session — no new entity, no new table | user |
| D4 | Jobs dying with the VM is intended; no external scheduler, no keep-alive. Non-payment closes the VM and everything stops cleanly | user |
| D5 | `agent.json`'s `mode` field is **deleted**; the session is the only source of a machine | assumed, unchallenged |
| D6 | Skills, not dedicated tools | user |
| D7 | Inline `StateMachineDefinition` on the create wire with **no gating** — no capability split, no state-kind allowlist, no key-kind check (`SECURITY.md:80`) | user |
| D8 | A scheduled task is a `timer → agent → timer` machine with terminal escapes; the canonical JSON lives in the skill, not in product code | user |
| D9 | The wire validates a **minimum interval** on scheduling states — a uniform cost guard, not a trust decision. **The floor is Duet's API policy and Duet owns its own number**; it need not equal duet-agent's 30s | user |
| ~~D9a~~ | ~~Upstream should enforce its floor at `start`~~ **struck.** `~/dev/duet-agent/src/turn-runner/tools.ts:1410-1413` deliberately exempts `mode:`-supplied definitions, on the stated grounds that a definition the agent did not author may legitimately run a shorter cadence. Asking upstream to overturn a decision it wrote down, to enforce a number that is Duet's policy, was the wrong direction. No shared constant export either — see slice 05 | territory |
| D10 | The drive root gets a default session too; uniqueness is per `(workspace, agent-or-root)` | user |
| D11 | Two skills: **`start-session`** and **`schedule-task`**, cross-referencing `duet`; `schedule-task` points at `start-session` for the create call | user |
| D11a | The "when" lives in a **generated default-session prompt layer**, not a skill — a skill cannot fire before the model knows it needs one | territory |
| D12 | ~~Inject current jobs into the system prompt~~ **reverted** — context cost and cache churn | user |
| D12′ | `start-session` documents job queries explicitly, including `agentId=root` (`ROOT_AGENT_SCOPE`, `contract/src/sessions/index.ts:123`) and the unscoped form | user |
| D13 | Reading a session's reply is a **skill-owned poll loop** (`POST /messages` → `GET /history?cursor=` until a terminal event → `complete.result`); no new endpoint | user |
| D14 | The default behavior for interrogating another session is **`follow_up`** — `note` deliberately does not wake the runner, and we want an answer | user |
| D15 | No timeout work: API pinned at `VC_MAX_DURATION=800` across all three function apps and test-gated (`apps/api/src/vercel-bundle-config.test.ts:26-55`); gateway at Bun's hard cap `idleTimeout: 255` | territory |
| D16 | Deleting an agent cancels its jobs | proposed, unchallenged |
| D17 | The default session is ordinary for archive and delete; the next open recreates it | proposed, unchallenged |
| D18 | **Any session may start sessions** (no depth limit), and the row records `createdBySessionId` | user |
| D19 | Lineage UI ships now: a **chip in the session header** ("started by X"). The Jobs-list "Started by" column was explicitly skipped | user |
| D20 | A child session's prompt layer **names its parent** and teaches it to interrogate it — stable content, so no cache churn | user |
| D21 | Create-from-session is a **nested route**, `POST /v1/ws/{slug}/agent/sessions/{sessionId}/sessions`, sharing one handler with the flat route. Parent is structural, not remembered — the onboarding-completion route exists in its session-keyed form for exactly this reason (`apps/api/src/routes/agents.ts:131-136`). Omitted `cwd` and `tier` **inherit from the parent**, which also inherits agent attribution | user |
| D22 | The default-session layer bans **work** machines, not all machines: a supervisor machine whose states only poll and report on other sessions is the sanctioned exception (e.g. "tell me when any outreach job gets a reply") | user |
| D23 | Injected messages carry an **`origin`** — `user` (default), `session:<id>`, `system`. The UI renders an attributed bubble instead of impersonating the user. Applies to the onboarding kickoff too, which has the same defect | user |
| ~~D24~~ | ~~Seed `jobView` at creation~~ **struck.** A definition is routing guidance, not a guarantee — if the user's prompt doesn't match it the runner answers in agent mode and never enters the machine. Seeding would list a job that never becomes one. The event-driven projection stays the only writer, and Jobs stays pure | user |
| D25 | **A scheduled wake must survive an intervening prompt, and must fire even if a turn is already running.** Reminders matter as much as polls. Whether today's code already satisfies this is **unproven** — see L2, which was rewritten after a second reading found the guarding invariant. The spec opens with a red-first kill gate: prove the failure with a real test or delete the wake work from the plan | user |
| D28 | Rollout goes all the way: publish `@duetso/agent` 0.3.8, **rebuild the VM image**, update envs, and push to **both staging and prod**. A fix the fleet isn't running cannot back the reminder half of `schedule-task`, and the staging journey cannot prove it | user |
| D29 | **No backward compatibility, no migrations.** `agent.json`'s `mode` is deleted outright and silently ignored where it lingers (`.loose()`); the web app's mode display is repointed, not dual-read. `createdBySessionId`, `origin`, and the default pointer are additive with no backfill | user |
| D26 | The default-session pointer lives on the **owner row** — `defaultSessionId` on `agents`, `rootDefaultSessionId` on `workspaces` — not as a flag/index dimension on `agentSessions` | proposed (see L3) |
| D27 | The default session is addressed by a **path alias, never by an id the client must first obtain**: `/v1/ws/{slug}/agents/{agentSlug}/sessions/default` (and `/v1/ws/{slug}/agent/sessions/default` for root) for snapshot, history, and messages. The server resolves the alias against `defaultSessionId`; if unset, the first POST creates the row through the ordinary create path and stamps the pointer. No idle-create path, no "never ran" status, no empty rows for unopened agents, and the browser navigates to `/w/{slug}/agents/{agentSlug}` without asking for an id. Real ids still come back in responses, so deep links and the lineage chip are unaffected | user |

---

## Quadrant 3 — Unknown knowns (what got extracted)

- **A job's transcript is read as an ordinary conversation, with the identical
  UI.** Not a log, not a special job view. This sets the register for what a
  scheduled `agent` state writes on each wake: normal conversational reporting,
  no ceremony, no structured status dumps.
- **Lineage belongs in the header, not the list.** The "Started by" column on
  the Jobs table was offered and declined — one placement, not two.
- **Machines in the default session are not categorically wrong.** The
  legitimate case is supervision: a machine whose only job is to watch other
  sessions and report. This reshaped D2 into D22 and changed the layer's prose
  from a ban to a distinction.
- **Inheritance beats parameters.** Given a parent in the route, omitted `cwd`
  and `tier` should inherit rather than be restated — the user reached for this
  unprompted, and it also makes agent attribution automatic.
- **The VM is the security boundary and the walk should not re-litigate it.**
  Raised once, corrected once; `SECURITY.md:80-125` and `AGENTS.md` were both
  sharpened during this walk so it does not recur.
- **This ships as a spec** under `specs/`, and **done means the live staging
  journey**: default session opens → user asks for a recurring check → the job
  appears in Jobs → the parent interrogates the child → the job wakes once on
  its timer.

---

## Quadrant 4 — Unknown unknowns (the sweep)

Swept the 14 files this touches: the contract's `agent`/`sessions` modules;
the convex schema and the `agentSessions` domain (delivery, events, queries);
the API's `agent`/`agents` routes; the gateway's coordinator, ledger,
agent-config, agent-context, your-apps-prompt; the skills registry; the SPA's
jobs/sessions/drive surfaces.

### L1 — a job is invisible in Jobs until its runner emits its first event · ACCEPTED AS CORRECT (D24 struck)

`jobView` and `relaySummary` are only ever written by
`applyStateMachineProjection`, off a runner event
(`packages/backend/convex/domains/agentSessions/events.ts:502-517`), and the
query layer deliberately treats a fresh session as `jobView: undefined`
(:288-290). A session created with a machine but not yet started is therefore
absent from the Jobs list until its first turn.

**Resolved as intended behavior, not a defect.** A definition is *routing
guidance* — duet-agent's own contract says that when the user's request does
not match the definition's `prompt`, no state is selected and the runner
answers in agent mode (`types/state-machine.ts`, the `StateMachineDefinition.prompt`
doc). A session can therefore be created with a machine and legitimately never
enter it. Seeding `jobView` at creation would advertise a job that never
exists. Jobs stays pure: a session is a job once its machine actually starts.
The skill hands the user the *session* link, which works immediately; the Jobs
row follows a moment later.

### L2 — scheduled wakes are silently destroyed, in four places · DECIDED (D25), BUGS BEYOND THIS FEATURE

State machines are used for one-time reminders, not only polls, so a wake that
fails to fire is a lost promise to the user — and it must fire even when a turn
is already running.

> **Read this first — the four "defects" below are LATENT, not proven live.**
> A first pass read four code paths literally and filed them as live bugs. A
> second pass found the invariant that guards them: **a turn cannot end while
> scheduled work is pending.** `pendingWork().kind === 'sleep'` breaks the turn
> loop and yields a `sleep` terminal (`~/dev/duet-agent/src/turn-runner/turn-runner.ts:996-1005`,
> `:1381`), so a prompt to a sleeping session re-emits `sleep` — normally with
> the same `wakeAt` — which re-arms every timer downstream. There is a passing
> test for exactly this (`test/session.test.ts:913`, "re-arms the same wake
> after a prompt during sleep"). Under that invariant U1 is masked, U3 drops
> only wakes with nothing pending behind them (a stale wake, arguably correct),
> and the gateway's claim is masked the same way. U2 survives as an ordering
> smell with a narrow window.
>
> **A second correction, found while drafting the ladder: U1 and U2 are not on
> Duet's path at all.** They live in `SessionManager`, and RPC mode — which is
> how the gateway spawns the runner — bypasses `SessionManager` entirely
> (`~/dev/duet-agent/src/cli/rpc.ts:210-211`). They are real for the TUI and
> library consumers, and worth fixing as hygiene, but they can never be the
> reason a Duet reminder goes missing. Only U3 is on our path.
>
> **Therefore the plan opens with a kill gate** — [slice 00](./slices/00-wake-kill-gate.md),
> which owns the details: a deterministic red-first repro of the one case
> reading cannot settle, a one-time reminder whose deadline lands while a turn
> is genuinely running. It must drive `TurnRunner.turn({type:'wake'})` directly;
> written end-to-end it goes green for the wrong reason, because no current
> caller ever hands a wake to a live runner.
> Red → fix and release 0.3.8. Green → the tests land as regression pins, the
> gateway's claim is still deleted as unnecessary complexity, **no release is
> cut**, and this section records the invariant so nobody re-files these
> findings. Only a real production sighting of a missed reminder outranks the
> test.

The four paths, described as written rather than as diagnosed:

**Duet — the wake claim consumes the wake.** `claimWakeForCommand` cancels the
armed timer and claims the wake generation; `finishWakeClaim` then *clears* it
rather than restoring it
(`packages/gateway/src/agent-sessions/coordinator.ts:290-308`). Any prompt to a
sleeping session destroys its pending wake. The claim exists to stop a second
dispatcher that cannot exist — there is one gateway per VM — so the fix is
deletion, not repair: keep a timer per sleeping session, fire it, send `wake`,
never cancel on prompt. Durability across restarts stays with the persisted
`wake` record; boot re-arms the timer instead of releasing claims.

**U1 — a user prompt cancels the pending wake, upstream too.** `prompt()`,
`answer()`, and `interrupt()` each call `cancelWake()` before dispatching
(`~/dev/duet-agent/src/session/session.ts:263, 276, 290`), and the only re-arm
is a terminal event of type `sleep` (`:533`). Chat during a pending reminder
and the reminder is gone.

**U2 — `fire()` cancels the poll before deciding whether it can dispatch.**
`cancelWake()` runs unconditionally once `wakeAt` passes, and only then is
`state.status !== "sleeping"` checked (`session.ts:609-627`). If the state is
not sleeping at that instant, the wake is dropped and the poll is already dead
— defeating the "poll every 30s so a sleeping laptop still wakes" intent stated
in the comment directly above it.

**U3 — a mid-turn wake reaches the runner and is discarded.**
`handleCommandDuringActiveTurn` correctly enqueues it as
`{type:"wake", queued:true}` (`turn-runner.ts:1073-1082`), and the turn loop
then `continue`s past it unless something is sleeping (`:953-960`). This is
exactly the reminder-arrives-during-a-turn case. The runner already routes
steer and follow-up mid-turn through `sendCommandToAgent`; a wake should be
handled the same way, or held and re-delivered at the turn boundary.

Consequence for sequencing: fixing the gateway alone is insufficient — U3
alone still swallows a reminder that lands mid-turn. The upstream change is a
prerequisite for the reminder half of `schedule-task`, though recurring polls
work without it.

Related: a clock-anchored schedule should use an absolute `wakeAt` rather than
a relative `wakeAfterMs`, so a turn that runs early cannot drift the schedule.
The canonical JSON in `schedule-task` uses `wakeAt`.

### L3 — the default-session pointer must not be another index dimension · DECIDED (D26)

`agentSessions` already carries 8 indexes, several 4–5 columns keyed on
structural dimensions (`archiveState`/`visible` × `jobView` × `status` ×
`updatedAt`, plus agent variants) — `packages/backend/convex/schema.ts:1009-1045`.
Adding `defaultSession` as another dimension multiplies that set against
Convex's 32-index cap. The `agents` table has 5 simple indexes and no session
pointer, so `defaultSessionId` there is one lookup by id, no new index, and
uniqueness for free; the Duet card's equivalent hangs off `workspaces`.

### L4 — a session cannot currently be created without running a turn · DISSOLVED (D27)

`createSessionForInitialDelivery` inserts with `status:'running'`, requires a
prompt, derives the title from a prompt excerpt, and appends a `user_prompt`
event (`delivery.ts:718-830`); onboarding works around this by burning
`ONBOARDING_KICKOFF_PROMPT`. That made "open the default session" look like it
needed either an idle-create path or a wasted turn.

It needed neither. The premise was that the client must hold a session id
before it can route anywhere. Addressing the default session by **path alias**
(D27) removes the premise: nothing is created on open, the first message
creates the row through the existing path, and the pointer is stamped then. No
new create path, no new status value, no empty rows.

### L5 — injected messages impersonate the user · DECIDED (D23)

`AgentUserPromptEventSchema` has no author field at all
(`contract/src/agent/index.ts:556-564`), and the onboarding kickoff is written
through the same path as a plain `user_prompt` with `inputKind:'initial'`
(`delivery.ts:798-812`). Every injected message — agent interrogation and
onboarding kickoff alike — renders as though the human typed it.

### Sharp edges — awareness only

- Deleting `mode` from `agent.json` is safe on the seeded side (all three
  official agents ship `{"triggers": []}`), but `resolveAgentConfig` is shared
  with the web app: `apps/web/spa/routes/agents/agent-mode.ts` and the agent
  detail canvas render a mode that will no longer exist and must be repointed
  at the session.
- Nothing caps sessions per workspace. With unlimited spawning (D18) the only
  backstop against fan-out is the Jobs list and workspace spend.
- A deleted parent leaves `createdBySessionId` dangling; the header chip needs
  a "(deleted)" state.
- `packages/skills-registry/src/generated.ts` is checked in and a test asserts
  that rerunning codegen produces no diff — new skills must be regenerated in
  the same commit.
- Agent-created sessions still pass `requirePreflightedSpendWorkspace`
  (`apps/api/src/routes/agent.ts:57`) and can 402; the skill must surface that
  rather than swallow it.
- Every additive field (`createdBySessionId`, `origin`, the seeded
  `stateMachine`) needs its convex validator updated alongside the zod schema,
  or syncs 500 — closed `v.object` arg validators are a second schema.

---

## Confirm before coding

1. **Does the fleet's pinned agent CLI accept `mode` on `start`?** The version
   is desired-state driven (`contract/src/vm/index.ts:229`); the repo's
   `node_modules` copy is 0.3.5, which does. Check the pinned value for both
   environments before relying on it.
2. ~~`MINIMUM_STATE_MACHINE_DELAY_MS` is not exported~~ **closed.** Irrelevant
   once the floor became Duet's own policy (D9 as amended): there is no shared
   constant to own, and Duet's number need not match upstream's. Slice 05 holds
   the reasoning.
3. **Does anything besides `applyStateMachineProjection` write `jobView`?**
   The seeded-at-creation path (D24) must not fight the event-driven writer on
   the first real event.
4. **Confirm the root default session's owner row.** `workspaces` is the
   natural home for `rootDefaultSessionId`, but check that no existing
   workspace-scoped default already implies one.

---

## ~~Tweakable plan~~ — SUPERSEDED by [`README.md`](./README.md)

> The ladder below was the map's first sketch. The spec's real ladder is
> [`README.md`](./README.md) plus `slices/00`–`13`. **Follow the README, not
> this section.** It is kept only to show what the plan looked like before the
> parallel drafts, and two of its assumptions did not survive them: the wake
> work is not one merged slice, and the upstream fix is narrower than it
> assumed (U1/U2 are off Duet's path entirely).

<details>
<summary>Superseded sketch</summary>


**Judgment calls — decide these first, they shape everything downstream**

1. **The wake-survival fixes (D25/L2).** Independent of the rest of the
   feature and worth landing first. Two halves: delete the gateway's wake
   claim/generation machinery (a net deletion), and fix U1–U3 upstream in
   `~/dev/duet-agent` so a wake survives a prompt and fires mid-turn. The
   upstream half gates the reminder use case; recurring polls work without it.
   Judgment call inside it: whether a mid-turn wake is delivered to the running
   turn as an input (matching the steer/follow-up path) or held and re-delivered
   at the turn boundary.
2. **The default-session prompt layer's prose (D11a/D22).** The load-bearing
   text of the whole feature — it decides whether the agent spawns a job or
   grinds through the work in the main chat. Draft exists; expect iteration
   against real sessions.
3. **`origin` on injected messages (D23) and how the SPA renders it.** Three
   values, one bubble variant, and a decision about whether the onboarding
   kickoff shows as `system` or stays visually as-is.
4. **The `default` path alias (D27).** Where the alias lives in the route tree
   and what the UI route is (`/w/{slug}/agents/{agentSlug}` vs a `sessions/default`
   form), plus whether root's alias sits under `/agent/sessions/default`.

**Mechanical — collapse these**

5. Contract: `mode` on `AgentStartSessionRequestSchema`, `createdBySessionId`
   and `origin` on the session/event schemas, the interval floor refinement.
6. Backend: `defaultSessionId` on `agents`, `rootDefaultSessionId` on
   `workspaces`, seeded `stateMachine`/`jobView`/`relaySummary` at creation,
   matching convex validators.
7. API: the nested create route with parent inheritance, the two
   default-session open-or-create routes.
8. Gateway: read `mode` from the launch envelope, delete `agent.json` mode and
   `loadAgentStartMode`'s config read, add the two new prompt layers through
   the existing resolver.
9. Skills: author `start-session` and `schedule-task`, regenerate the registry.
10. Web: the header lineage chip, repoint `agent-mode.ts`, default-session
    entry points on the roster cards.
11. Staging journey in `packages/test-harness`, registered in
    `src/staging-e2e-synthetic`.

</details>
