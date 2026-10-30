# Agent delegation — rationale record

> **The one-layer rule is superseded by
> [`../inter-agent-visibility/`](../inter-agent-visibility/README.md).** Siblings
> are now reachable, and the prompt carries a delegation *policy* — down to
> children, sideways to a sibling as a fallback, up only to report or ask — in
> place of a scope that made the cycle unaddressable. Read "One layer each way"
> below as the reasoning that rule was drawn from; the deadlock it describes is
> still real, and is still guarded only by prose.

**Shipped to staging 2026-08-09; live journey green
(`bun run e2e:staging -- --journey agent-delegation`).** Built from the
quadrant walk in [`MAP.md`](MAP.md); the decisions made without Example User are in
[`choices.md`](choices.md).

## What shipped, and the problem

Agents could not see each other. A session's system prompt listed its apps but
not its colleagues, so an agent asked to "get Research to do this" had to
discover the roster through REST, if it thought to look at all.

Every non-onboarding session now receives a fifth generated prompt layer,
`your-agents.md`: the agents one layer below it, the one agent above it, and
the recipes for holding a conversation between them. Root delegates by POSTing
into a child's home chat with `sourceSessionId` and *blocking*; the child
answers a question by **ending its turn with an `ask` terminal**, which
resolves the caller's wait; the caller answers through `/answer/wait` and keeps
waiting until `complete`. The agents map draws the same one-layer story, and
the drive root became an ordinary agent address (`agents/root`) on the wire.

## Why this shape and not the obvious alternatives

- **Blocking + `ask`, not a mailbox.** A mailbox (async messages both ways)
  was designed and rejected: it needs the callee to *address* its caller,
  multiplies prompt surface, and turns every exchange into several turns on
  both sides. The blocking shape uses only rails that already existed — the
  foreground wait and the `ask` terminal — and a kill-gate probe measured the
  full chained loop at 112s against the 720s wait ceiling before anything was
  built on it. The closing live run did it in 62s
  ([`assets/live-journey-evidence.json`](assets/live-journey-evidence.json)).
- **One layer each way, not the whole tree.** Scoping is the deadlock guard,
  not just tidiness: `follow_up` into a session that is blocked waiting on you
  hangs both sides on 202 forever, and one-layer visibility makes the A→B→C→A
  cycle unaddressable. Asks chain correctly up a deep tree without any session
  ever messaging a blocked waiter. Widening visibility reopens this.
- **The roster rides VM sync, not a push.** The prompt file is regenerated
  every turn (every terminal kills its runner), so poll-bounded freshness is
  invisible in a conversation. The synchronous topology-push alternative is
  recorded in `choices.md` §11 with the condition under which it becomes right.
- **Root is a member of the wire roster, not an `agents` row.** A direct child
  of root cannot name its parent otherwise. `GatewayAgentConfig` is a
  discriminated union with a `root` member wearing `workspaces.duetName`; the
  reserved slug grammar guarantees `kind` and `slug` can never contradict.

## Invariants the code must keep honoring

- **One containment rule.** `groupAgentsByParent`
  (`packages/contract/src/agents/index.ts`) is the only agent-hierarchy
  algorithm — self-excluding by construction, because `resolveNearestAgent`
  counts an exact path match as a hit and a naive reuse silently renders every
  roster empty (its first test is that negative). No path-prefix filtering
  anywhere: not the roster, not the map, not the rail.
- **The reply rule is stated once and never contradicted below.**
  `your-agents-prompt.ts` owns it, mechanically ("it cannot end its turn until
  you end yours"); `parent-session-prompt.ts` is narrowed to the idle-parent
  case — its pre-existing recipe *was* the deadlock.
- **Enrichment is composition-time; durable rows stay id-only.**
  `resolveCurrentModelSender` (`runnerEnvelope.ts`) resolves `agent_slug` /
  `agent_name` fresh per delivery — never from `agentSessions.agentName`, a
  stale denormalized copy — so a rename shows up on the next delivery and the
  timeline never holds a second source of truth.
- **One topology scan.** `projectVmTopologyImpl`
  (`domains/anchors/model.ts`) produces `GatewayAnchor[]` and
  `GatewayAgentConfig[]` from one walk, so "is this agent live" has one branch;
  a disabled agent loses its anchor's `agentId` and its roster row in the same
  expression. The quiesce branch of `readVmSyncStateImpl` hand-builds its
  return and must keep sending `agents: []` — absent means keep-what-you-have
  (an older API), empty means clear (`createAgentRoster` enforces the split).
- **Both prompt-assembly sites.** `agent-context.ts` builds the stack in
  `contextForAgent` *and* `defaultAgentContext`; a layer added to one silently
  skips root sessions. `agent-context.test.ts` pins both.
- **Locked is a three-part predicate.** `agentIsLocked` (contract) — declared
  onboarding, readable config, no completion stamp. `onboardedAt === undefined`
  alone is the permanent state of every agent without an `agent.json`; keying
  on it flags nearly every working agent (the map's D4 was corrected for this).
- **Prompt-safe names have one sanitizer.** `sanitizePromptLabel`
  (`prompt-text.ts`) serves the apps and agents blocks; neither name schema
  restricts characters, and an author's backtick or newline must never reshape
  a prompt block (tests pin the exact heading set).
- **The map's ring is visibility, the directory is reachability.**
  `projectWorkspaceMap` draws only root's children but its `agentDirectory`,
  `routes` and `activity` stay complete; `focusOf` resolves deep links from the
  directory, and the rail lists the directory because the escape hatch loses
  nobody. Captions count the ring — a caption's one job is to match the
  picture beside it.
- **One route family for default chats.** `resolveDefaultSessionOwner(runtime,
  workspaceId, agentSlug)` answers `root` before the slug query (the reserved
  slug would throw, not miss). The old `/agent/sessions/default*` family is
  gone; the owner is a plain token end to end (`ROOT_AGENT_SCOPE`, owned by the
  slug module beside the reservation it names).

## Pointers

| What | Where |
| --- | --- |
| Hierarchy + wire row + locked predicate | `packages/contract/src/agents/index.ts` (`groupAgentsByParent`, `GatewayAgentConfigSchema`, `agentIsLocked`) |
| Roster prompt renderer | `packages/gateway/src/agents/your-agents-prompt.ts` (the samples asset that once pinned it was removed 2026-10-18; render with `bun run prompt:print`) |
| Prompt assembly (five layers, both sites) | `packages/gateway/src/agents/agent-context.ts` |
| Roster transport | `projectVmTopologyImpl` → `VmSyncResponseSchema.agents` → `createAgentRoster` (`agent-roster.ts`) → the sync sink in `runtime/http.ts` |
| Envelope identity | `packages/backend/convex/domains/agentSessions/runnerEnvelope.ts` |
| Root route cutover | `apps/api/src/routes/default-session.ts`, `session-waits.ts`; web owner token in `spa/sessions/default-chat.ts` |
| One-layer map | `spa/knowledge-map-data/project.ts`, `routes/agents-map/where.ts`, `agent-surface/index.tsx` (child chips), `agents-rail/roster.ts` |
| The journey (definition of done) | `packages/test-harness/src/staging-e2e-synthetic` |

## Dead ends and divergences worth not re-walking

- **The mailbox interaction** (see above) — designed in the map, never built.
- **`onboardedAt` alone as the locked flag** — the map shipped this wrong; the
  correction is recorded at MAP.md D4.
- **Slug/name fields on `GatewayAnchor`** — rejected; anchors own path
  identity, agents own agent identity, they join on `agentId`.
- **A stub route for the deleted family** — rejected as compatibility
  scaffolding; the old URLs 500 like any malformed session id does
  (`choices.md` §1 names the underlying, unfixed defect).
- **The recipe's answer leg shipped unattributed** and was caught by review
  before deploy — an unattributed answer arrives as `kind:"system"` and the
  journey itself would have failed (`choices.md` §4).
- **The one-off wait-ceiling probe** was deliberately created, measured, and
  deleted. Its record: four runs — two dead in provisioning, one whose silent
  wait the transport cut at 268s, one green at 112s. The 268s cut remains an
  open observation (choices.md §3): nothing in this feature waits that long,
  but a future long wait should expect it.
- **The suite kit's envelope grammar** deliberately mirrors backend enrichment
  (`apps/api/src/index-suite.ts`, `envelopeIdentity`) — composed pins carry
  agent identity, durable-history pins never do.

## Provenance

No visual baselines drove this feature; its "look" is prose read by models.
The standard the prose was held to is preserved instead:
a samples asset was generated from the shipped renderer and test-pinned
byte-for-byte (removed 2026-10-18, when prompt text became config), and it passed an
unprimed cold read (a fresh agent produced the correct call sequence from the
text alone) before the wording froze. The build ladder itself is
collapsed, per the done-spec convention; MAP.md preserves the exploration and
its decision log.
