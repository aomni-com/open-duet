# Agent onboarding, trainable, and campaign-carried agents

Shipped to staging and production 2026-07-27, corrected and re-verified live on
staging 2026-07-29 (see **Corrections after close**). The corrections are live
on staging and **not yet in production**, which deploys from `main`. Planned
with a quadrant walk
([`MAP.md`](MAP.md)), built as a 15-slice ladder, and verified live on staging.
This document is the *why* and the *invariants*; the code is the source of truth
for *how*, and the pointers below lead into it. Every decision made without the
owner — including the ones he later ruled on — is in
[`choices.md`](choices.md), which is the review surface rather than the diff.

## What shipped

An agent can declare an **onboarding** experience in its `agent.json`: a chat
that runs under the agent's own `ONBOARDING.md` as system prompt, or one of the
agent's own apps. Until the workspace marks that agent onboarded, its card
collapses to a single "Onboard agent" button — sessions, apps, and skills stay
out of reach, while training and management do not. The onboarding chat or app
finishes by calling the onboarded endpoint itself; that call unlocks the agent
and lands the user on its new-session page with a congratulation moment. The
chat's generated instructions name the session-scoped form
(`POST …/agent/sessions/:sessionId/onboarded`) so the agent needs nothing it
does not already hold; `POST …/agents/:slug/onboarded` is the human's toggle
(card, redo) and the fallback when the gateway does not yet know its workspace
slug.
`trainable: false` removes the training surface for agents that have no use for
it. Campaigns can carry official agents, so a signup through one auto-installs
them, skips the agent-selection step, and walks their onboardings in order.

The problem it solves: some agents cannot do anything useful until the user
supplies something — brand colours, style references, a preferences file the
agent writes for itself. Before this, an agent author had no way to demand that
setup, and no way to know it had happened. The lock makes the requirement
first-class; the per-workspace timestamp makes "has this user done it?" a fact
the product can read.

**The campaign half ships dormant.** No campaign names an official agent and no
official agent declares onboarding, so nothing locks for anyone today. Turning it
on is one data edit in this repo — `starterAgents: [...]` on a campaign in
`packages/backend/convex/domains/campaigns/config.ts` — plus authoring the
`onboarding` block on the named agents, which happens **in the official hub VM,
not here** (see the seed invariant below). Dormancy is guarded, so that data
edit turns `config.test.ts` red on purpose; deleting the guard is part of the
edit, not a symptom of breaking something.

**The seed is a bootstrap, not the catalog.** `packages/official-agents-seed`
runs once to stand the hub workspace up; `beginSeed` returns `state: 'existing'`
on every later call and the route exits before writing a byte, so re-running it
never re-registers, rewrites, or resurrects anything. After that the hub VM owns
the official agents: they are authored there, and deleting one there keeps it
deleted. The live catalog is whatever `OfficialCatalogService.refresh` finds in
the hub's published folder at request time — so nothing in this repo may treat
the seed's contents as the set of agents that exist. That is why
`defineCampaigns` does not validate `starterAgents` names against the seed:
doing so would throw at Convex module load and break the deploy for a campaign
naming a legitimately VM-authored agent.

## The reason it works this way

- **Onboarding is a session, not a mode.** The conversation is an ordinary,
  resumable, directly-readable session that simply never appears in a list, job
  view, or search — hidden in the query rather than after it, because
  post-filtering a page and discarding rows hands users short or empty pages.
  Two consequences follow and are deliberate: lifecycle sweeps do **not** inherit
  the hiding (deleting an agent must still kill its live onboarding runner, and a
  hidden turn still needs runner delivery), and onboarding turns emit no
  analytics and generate no title, because the `grow` campaign's fit classifier
  counts messages and a scripted setup exchange would score every campaign signup
  as engaged before the user did anything.

- **Identity is immutable; parameters keep tracking.** The gateway persists a
  small launch record per session — the folder, the model, and whether it is an
  onboarding session — so it can restart after a crash, reboot, or scheduled
  wake. `onboarding` decides which system prompt *every* relaunch uses, so
  creation settles it and no later request can flip it; `cwd` and the model are
  things a user legitimately changes mid-session, so the newest accepted input
  wins. Conflating the two froze the model, and a mid-conversation model switch
  silently reverted on the next wake. That same bug pre-existed this feature on
  the live-runner path and was fixed here.

- **The onboarding system prompt is layered, and `ONBOARDING.md` is optional.**
  The runner renders each `--system-prompt-file` as its own
  `<system_prompt_file>` block in the order given and skips files that do not
  exist, so an onboarding session gets the author's `ONBOARDING.md` (if there is
  one) followed by a Duet-owned completion block. Optionality is therefore free:
  an agent with no `ONBOARDING.md` still onboards and still completes, it just
  has nothing specific to ask.

- **The product, not the author, guarantees completion.** Nothing but the
  onboarded endpoint ends the locked state, so an author who forgot to write
  "then call it" would leave the user staring at a card whose only button they
  had already pressed. The completion block is generated per agent into the
  gateway's own state directory — outside the drive, so it never syncs, never
  publishes, and cannot be edited by the agent it instructs.

- **The completion call must need nothing the runner doesn't already hold.**
  The generated block asks for exactly one call addressed by the session's own
  id (`$DUET_SESSION_ID` is in every runner's environment); a version that
  asked the model to first derive the workspace and agent slugs was skipped
  outright by a live runner, which finished its interview, announced
  completion, and left the user locked out. Zero derivation is the compliance
  fix, not a nicety. For the same reason onboarding sessions carry no
  your-apps layer: its cwd-moving teaching pulled a live interview into an app
  folder on its opening turn, and the interview must stay under the anchor it
  is onboarding.

- **What onboarding must never do is fall back to `AGENTS.md`.** A missing,
  unreadable, or drive-escaping `ONBOARDING.md` yields no authored layer at all
  rather than the agent's ordinary persona. The user believes they are being
  onboarded; silently running a different agent is worse than running a sparse
  one, and onboarding sessions are *reused*, so a session created during
  share-sync lag would keep the wrong prompt forever.

- **The onboarding app is addressed by path, never by slug.** A shared copy's app
  slug can be collision-suffixed while its path under the mount is preserved, so
  slug matching would silently resolve the wrong app — or the recipient's own
  unrelated one.

- **Completion is per workspace, so adding onboarding re-locks existing
  installs.** Every workspace that has not completed it sees the lock again on
  its next sync. That is the intended lever for "everyone must go through the
  new setup" rather than an accident, and it is documented for authors as such —
  but it means an agent author's edit reaches into workspaces they do not own.

- **The lock is a hint, never a fact.** `agent.json` is read from the workspace
  VM, which can be paused or booting, so no product logic may treat "locked" as
  ground truth. This is why the campaign chain waits on the install subscription
  instead: an agent's row goes active the moment it is registered, while its
  folder bytes are still landing, so both the anchor state and the lock would
  report ready too early.

- **Schemas accept unknown fields.** Rejecting them made adding one optional
  field a fleet-wide, deploy-ordered migration; 183 rejecting schemas across the
  repo became accept-and-strip, with seven pass-through exceptions for content
  that must survive a read-and-rewrite by an older reader. Exactly one rejection
  survives, and it is about *meaning* rather than versions: the `Share` union
  (`packages/contract/src/shares/index.ts`) has no discriminant field, so Zod
  picks a branch by which one refuses the other's payload — under strip the
  first branch swallowed everything and dropped `tokenPrefix`. The hosted MCP
  `train_start` had been relying on rejection for a different purpose, keeping
  file bytes out of the tool surface; it is now an explicit deny-list
  (`z.never().optional()` on the byte-bearing fields) so unknown future fields
  pass while forbidden ones fail loudly. See
  [`assets/strict-schema-inventory.md`](assets/strict-schema-inventory.md).

## Invariants — what must stay true

- **One owner for `agent.json` meaning.** `resolveAgentConfig` turns bytes into
  meaning; the gateway and the web app each read the file and both delegate what
  it means. A third parse site is a regression.
- **One lock derivation and one app-visibility filter.** All three app surfaces
  filter through the same function; a filter applied to two of three is a
  half-hidden app. Hidden never means unreachable — direct app routes resolve
  from the raw response.
- **Every config-derived surface fails open.** Unreadable config ⇒ unlocked,
  trainable, all apps visible.
- **The onboarding fact has one source of truth**: the Convex session row,
  stamped at creation. The API re-derives it onto `launch` on *every* dispatch,
  because the gateway rebuilds its launch from whatever arrives; a client-sent
  flag after creation is ignored.
- **Hiding is an index dimension, never a post-filter**, and lifecycle sweeps
  must not inherit it.
- **`onboardedAt` is replica-local.** Replication, metadata fan-out, and detach
  never copy, clear, or propagate it.
- **Chain readiness is `subscription.state === 'active'`** plus, for app-kind
  onboarding, the resolved app's `runtimeStatus === 'reconciled'` — never the
  anchor state, which goes active at registration while folder bytes are still
  landing. (The chain does read `onboardedAt`, but only to skip an agent already
  completed; it is not an input to readiness.)
- **Campaign installs are server-derived** from the user's immutable acquisition
  attribution; the client's selection is additive and can never remove or reorder
  the campaign set. Install is idempotent — the same agent at its canonical path
  is adopted, not refused.
- **The prompt path has one containment-checked owner.** No caller builds its own
  `join`, so a symlink cannot escape the drive. Prompt-file paths handed to the
  runner are absolute: a relative name would be joined onto the runner's cwd and
  silently resolve to nothing, dropping the layer without a word.
- **An onboarding launch never loads `AGENTS.md`.** The authored layer is
  `ONBOARDING.md` or nothing.

## Why onboarding turns are slow: the VM, not the code

**Root cause established 2026-07-30 and it is not in this repo.** exe.dev VMs
run at ~37% of nominal CPU — 63.4% average hypervisor steal, measured on five
VMs including two live production workspaces. A noop process spawn costs ~19s
on them. The same agent reaches `turn_started` in 1.2s on a laptop and ~4.4s
under *emulation* in the identical VM image, versus 119–376s natively on
exe.dev. Full evidence, everything eliminated, and the support-ticket repro:
[`assets/e2e/vm-cpu-starvation.md`](assets/e2e/vm-cpu-starvation.md).

This affects real users, not just the journey: pressing "Onboard agent" today
means a multi-minute wait for the first token. No timeout tuning or agent
optimization reaches a 15s budget when a noop spawn alone costs 19s — the fix
is capacity on the provider's side.

## The stall Leg B found, and the two bugs behind it

Leg B was red for a week's worth of reasons in one evening, and both causes were
real product defects that no local suite could see. Full trail:
[`assets/e2e/stalled-onboarding-delivery.md`](assets/e2e/stalled-onboarding-delivery.md).

**One wedged session starved every session behind it.** The per-workspace
runner-input drain aborted its whole pass when a dispatch *returned* a failure.
It handled a *thrown* failure correctly — the comment there states the rule —
but a gateway 503 is a returned failure. Since the next tick re-selects the same
ordered set, one wedged session became a permanent head-of-line blocker. Only
this journey opens two onboarding sessions in one workspace, which is why single
-session journeys never saw it (`apps/api/src/agent-runner.ts`).

**The turn-start ceiling could not converge.** Cold starts exceeded the 90s
`turn_started` bound — measured at 90512/90711/90904/91274ms — and on timeout the
gateway *kills* the runner, so each retry cold-started into the same wall.
Raising the bound is a mitigation, not the cure: the durable fix is to stop
killing a runner that is still starting. Start latency is now logged
(`runner_turn_started`) so the bound stops being guesswork
(`packages/gateway/src/runner/process-runner.ts`).

Both were invisible from outside the VM, which is why
`GET /v1/internal-admin/workspaces/:id/logs` exists and why this journey now
captures the gateway's own log on failure.

## Corrections after close

Three defects were found after this spec was archived and fixed on `staging`,
where all three are now live and proven. They are **not in production**, which
deploys from `main`; the branches have not been merged.

A stale VM image does **not** hold them back, which is worth knowing before
scheduling one. Gateway code reaches a VM through the release rail the API
deployment publishes, so pushing `staging` was enough: the run below provisioned
a VM from the 2026-07-27 image and still exercised the layered prompt. The image
governs which bytes a fresh VM *boots*, not which it ends up running.

- **The completion instruction was in the wrong place** (`d979391b`). It sat in
  the opening user turn, and `ONBOARDING.md` was made mandatory to compensate.
  Now the gateway layers the optional `ONBOARDING.md` and then a generated
  completion block, per the invariant above. Proven live on staging by Leg B
  below.
- **The completion call was a derivation ceremony** (`5d749dc6`). The block
  asked the model to resolve the workspace slug (whoami) and its own agent
  slug (list + filter on anchorPath) before it could POST. Two live runners
  finished the interview, announced "Onboarding complete.", and never
  attempted it. Completion is now one session-scoped call; audit provenance
  records the `sessionId`, so self-completion is distinguishable from a
  human's toggle. Verified 4/4 in a local harness driving the real layers and
  the real `recommended` model before the live journey confirmed it.
- **The your-apps layer reached onboarding sessions** (`03a72205`). Merged in
  from session-app-pane, it teaches sessions to move their cwd to an app
  folder — and a live onboarding agent obeyed it as its very first act,
  burning the opening turn wandering and recovering. Onboarding launches now
  exclude the layer.
- **An onboarding launch could race anchor reconciliation and pin the root
  context** (`30fbd9b2`). The session envelope freezes agent identity at
  creation, and anchors reach the VM asynchronously — a session opened right
  after agent registration could arrive first, resolve to no agent, and run
  the whole interview as the root persona: workspace apps prompt, no
  `ONBOARDING.md`, no completion contract. Load-dependent: one run won the
  race, the next lost it. The gateway now refuses to create an onboarding
  envelope with no agent bound (503), and the API's drain redelivers until
  the anchor lands. The tell in the logs: an onboarding session with zero
  `agent_memory_db` events, which only the agent-bound context emits.
- **The seed was being treated as the catalog** (`680ff0c0`). See the seed
  invariant above.
- **Two assertions could not fail** (`e3fed8c3`), both spelled against a
  property the rename had removed.

## Release rules — process, not code

Nothing in the repo enforces these; they are runbook conditions, kept here
because getting them wrong is not visible in a diff.

- **Production runs the exact image digest staging verified** — a promotion of
  the same bytes, never a second build.
- **Deploy ordering.** The API deployment both publishes the gateway release and
  contains the sender (`apps/api/src/routes/vm.ts` serves the release;
  `apps/api/src/agent-runner.ts` attaches the flag), so "deploy the API, then
  check convergence" protects nothing. A single-phase rollout is safe only while
  no agent anywhere declares onboarding — true at ship time. Once official
  agents carry onboarding config, a receiver-first two-phase rollout is
  required. The blast radius is bounded either way: the flag is attached only to
  onboarding sessions, so a skew window strands those rather than the fleet.

## Pointers into the code

| Concern | Owner |
|---|---|
| Config grammar, defaults, fail-open resolver | `packages/contract/src/agents/index.ts` |
| Launch wire (`launch.onboarding`) | `packages/contract/src/agent/index.ts` |
| Per-workspace `onboardedAt`, toggle mutation | `packages/backend/convex/domains/agents/model.ts` |
| Hidden-session dimension, indexes, search filter | `packages/backend/convex/schema.ts`, `domains/agentSessions/queries.ts` |
| Open-or-create onboarding session, kickoff prompt | `domains/agentSessions/delivery.ts` |
| Analytics suppression for onboarding turns | `domains/agentSessions/agentSessionsShared.ts` |
| Sweeps that must see hidden sessions | `domains/agentSessions/events.ts` |
| Launch projection onto every dispatch | `apps/api/src/agent-runner.ts` |
| REST: onboarded toggle, onboarding-session resolver | `apps/api/src/routes/agents.ts` |
| Campaign carrier + server-side derivation | `domains/campaigns/{config,starterAgents}.ts` |
| Idempotent official install; once-only hub seed | `domains/marketplace/model.ts`, `domains/internalAdmin/officialHub.ts` |
| Prompt selection + containment, forced-mode skip | `packages/gateway/src/agents/{agent-context,agent-config}.ts` |
| Durable launch record (identity vs parameters) | `packages/gateway/src/agent-sessions/{ledger,coordinator}.ts` |
| Web config owner and pure projections | `apps/web/spa/drive/{agent-config,agent-onboarding-projection}.ts` |
| Locked card body (roster + detail) | `apps/web/spa/drive/agent-roster-rail.tsx`, `spa/drive/agent-roster.tsx`, `spa/routes/agents.tsx` |
| Onboarding CTA, mount-scoped flip watch, congrats | `apps/web/spa/drive/agent-onboarding-cta.tsx`, `spa/drive/agent-onboarding-watch.ts`, `spa/routes/sessions.tsx` |
| Campaign chain transition + orchestrator | `apps/web/spa/onboarding/onboarding-chain*.ts(x)` |
| Author-facing contract | `packages/skills-registry/skills/manage-agents/SKILL.md`, `apps/docs/app/agents/page.mdx` |
| Live acceptance journey | `packages/test-harness/src/staging-e2e-synthetic` |

Behavior is pinned by tests. Web and gateway suites sit beside their owners;
the Convex and API owners are covered one package level away, in
`packages/backend/src/{agents,agent-sessions,agents-replication,official-agents,official-hub-seed}.test.ts`
and `apps/api/src/{index,official-agents,internal-admin}.test.ts`.

## Acceptance evidence

A live staging journey ran 2026-07-27 (`staging-e2e-synthetic`)
against deployed services and a real VM: a declared chat onboarding rendered a
locked card, the resolver returned one conversation across repeated presses,
that conversation was absent from the unscoped, archived, and searched lists
while staying directly readable and correctly attributed, the onboarded call
unlocked the card, and redo re-locked it. Cleanup passed with zero orphans.

**Leg B — the agent completes its own onboarding** (added 2026-07-29, green on
`staging-e2e-synthetic`). Leg A makes the onboarded call
itself, so it never covered the product's central promise. Leg B does: the
harness only presses the button, and the agent marked itself onboarded 254s
later, unattended.

It separates the two prompt layers so a failure names the guilty one. Only the
authored `ONBOARDING.md` names the marker file and its token; only the generated
completion block names the endpoint, and that interview deliberately never
mentions it. Onboarded-with-no-marker means the authored layer went missing or
the agent finished before doing the work; marker-with-no-onboarded means the
completion layer did. `buildSelfCompletionInterview` is pure so the property the
leg depends on — that the interview never leaks the endpoint — is pinned by
`staging-e2e-synthetic` without touching staging.

One honest limit: the `manage-agents` skill in the sandbox also documents the
endpoint, so in principle it supplies the *how*. It supplies no reason to call
it — nothing but the completion layer tells an onboarding agent that marking
itself onboarded is its job — so a pass still evidences that layer arriving.

`assets/e2e/run-evidence.json` is the harness's returned evidence and cleanup
ledger — identifiers and outcomes (including `onboardingSessionId ===
reusedSessionId` and `relockedAfterRedo`), not the assertions themselves. The
assertions live in `packages/test-harness/src/staging-e2e-synthetic`
and are what the run executed; the JSON is what it recorded.

**Visual standard.** [`assets/e2e/agent-onboarding-locked.png`](assets/e2e/agent-onboarding-locked.png)
is the shipped locked card, held against the "V2 Compact" shape chosen at
planning ([`MAP.md`](MAP.md)): the card keeps its ordinary header — avatar,
name, status dot, ⋯ menu — and replaces only its body with one full-width
action, so unlocking causes minimal layout shift.
[`assets/e2e/agent-onboarding-unlocked.png`](assets/e2e/agent-onboarding-unlocked.png)
is the same agent after completion, and is the proof of that standard: the
header is unchanged while the body has become the ordinary sessions list, with
the new-session and ⋯ controls restored and no onboarding action anywhere.

**A note on how this shot was earned.** The first run's unlocked capture was a
loading skeleton, and the journey passed anyway: it asserted only that the
"Onboard agent" button was *detached*, which an unpainted roster satisfies
vacuously. The check is now positive-then-negative — wait for the agent's own
card to render, then assert no onboarding action exists — and the screenshot
above is from the re-run that proved it. A negative assertion about a page needs
a positive one first, or it certifies nothing.

## Divergences from the plan

- **"Loose everywhere" was wrong and had never been compiled.** Zod's
  pass-through output type adds an index signature that collapses Hono's
  response typing. The rule became per-seam: pass-through for authored content
  and persisted envelopes, accept-and-strip for response projections.
- **The launch envelope predates this feature** (2026-07-20, with the durable
  session ledger). Only the optional `onboarding` field is new — which is why the
  stale-launch bug it exposed was pre-existing rather than introduced.
- **The e2e's campaign leg was not built.** It cannot run without a campaign that
  actually carries official agents, and inventing that mapping would retroactively
  lock installed agents in both environments. Leg A covers the whole direct
  contract.
- **The original release ordering was written on a false premise** — it treated
  the web app as the sender. The API deployment is both the gateway
  publisher and the sender, which is why the ordering invariant above is phrased
  around the dormancy precondition instead.

## Dead ends (do not re-walk)

- **A silent `AGENTS.md` fallback when `ONBOARDING.md` is missing.** Rejected:
  session reuse makes the mistake permanent.
- **Requiring `ONBOARDING.md`, and refusing the launch without it.** Rejected
  after it shipped: it solved "the agent might not know to complete" by making
  the file mandatory, when the completion instruction belongs in the system
  prompt regardless. The layered prompt solves both, and leaves the file
  optional like every other prompt file.
- **Putting the completion instruction in the opening user turn.** Rejected: it
  is an instruction about how the session must behave, which is what a system
  prompt is for, and a user turn can be argued with or scrolled past.
- **Resolving the onboarding app by slug.** Rejected: replica slugs are
  collision-suffixed.
- **Keying chain readiness on the anchor state or on the lock.** Rejected: the
  agent row and anchor go active synchronously at install, before any folder
  bytes land, so both report ready too early.
- **Server-side enforcement of the lock.** Rejected: the onboarding chat and app
  legitimately call other endpoints while the agent is still locked.
- **A static visual baseline for the hidden-app surface.** Rejected: that surface
  mounts a live iframe and can never be hermetic in the playground; the behavior
  is pinned by component tests instead.
- **Merging the `Share` union's two branches into one both-optional object.**
  Rejected: it would let a recipient-facing projection legitimately carry a token
  prefix it must never see.
