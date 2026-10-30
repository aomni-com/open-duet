# Inter-agent visibility — rationale record

> **2026-10-18:** the prompt layer was cut to the parent and children, with
> siblings counted; the recipes this record describes (`## Reaching one of
> them`, `## Going to your parent`, the naming tag) moved to the `duet` skill's
> `references/agents.md`, read on demand. The roster projection, the picker and
> the reply rule are unchanged. The generated samples asset and the test that
> pinned it are gone too: prompt text is config, and `bun run prompt:print` in
> `packages/gateway` renders the live layer in context. The sections below
> describe the layer as built.

**On `origin/staging` 2026-08-16** — the feature is `10ebefdac`; this record and
the prompt-samples asset's move here landed in the close commit after it. Prod
untouched; promotion is a separate call.

An agent used to see two kinds of colleague: the one above it and the ones
below. It now also sees the ones beside it — **siblings**, the agents sharing
its parent — in its `your-agents.md` prompt layer and in the compose bar's `@`
picker. Every row states which kind it is, and that word carries a policy about
what may be sent in that direction.

Built from the quadrant walk in [`MAP.md`](MAP.md); the decisions made during
the build, without the user, are in [`choices.md`](choices.md).

## What the reachable set is now

Self, the parent, the parent's other children, and this agent's own children.
Not the whole tree: a grandchild still cannot see its grandparent's other
children. The narrowing is deliberate preparation rather than a present-day
constraint — every product surface today creates agents flat under the drive
root, so in practice siblings *are* every other agent in the workspace. The
rule exists for the hierarchy the product can already produce — nothing rejects
a nested `path` on `POST /v1/ws/:workspaceSlug/agents`, so an agent following
`manage-agents` can create one today — rather than for the shape the UI happens
to make.

## Why this shape and not the obvious alternatives

**The relationship is a value, not a position.** The roster used to be
`{ self, parent, children[] }`, and each consumer inferred a row's standing from
which array it arrived in. Adding a third relationship forced the choice, and it
went the other way: one ordered `rows[]` where each row carries
`relationship: 'self' | 'parent' | 'sibling' | 'child'`. The property being
protected is the one this whole area exists for — the prompt and the picker must
never describe one roster two ways — and a relationship each surface re-derives
is a relationship each surface can derive differently. It is also less code:
one array to order, one place assigning the label.

**The enum value is the prompt copy and the badge text.** `sibling` is
simultaneously a type, a wire value, and the word an agent reads. One vocabulary
means the person composing `@Peer` and the agent reading the roster use the same
term. The cost is real and worth stating: renaming a relationship rewrites every
agent's system prompt. `assets/your-agents-samples.md` is pinned to the renderer
by a test, so it cannot happen silently.

**Visibility and reachability are the same set.** The alternative — list
everyone, allow delegation to one layer — was rejected twice over. A roster
where some rows are look-but-don't-touch is a distinction models flatten within a
turn, and it buys no real safety anyway: `GET /v1/ws/:ws/agents` already returns
every agent in the workspace to any caller holding the workspace key, and the old
prompt pointed agents at that route by name whenever the row cap dropped a child.
One layer was a prompt default, never an enforced boundary.

**The deadlock guard is now prose, and that is a real reduction in safety.**
Delegation blocks: a caller POSTs into a callee's home chat and sits in a 202
retry loop. `SESSION_WAIT_TIMEOUT_MS` (720s, `apps/api/src/session-wait.ts`)
bounds one *request*, not the wait — the recipe loops on 202 unconditionally, so
a closed cycle hangs indefinitely, re-arming every 720s. The old one-layer scope
made `A→B→C→A` unaddressable; siblings make it addressable again. Two-cycles
always were, since the old prompt explicitly allowed handing the parent a task.

What holds the line now is thinner than it looks, and the old wording that
looked like a guard is gone: the deleted prompt said an agent could be handed a
task "when it is not already waiting on you", and nothing replaced that clause.
What survives is narrower — the parent section warns only about *your parent*,
and only when its message started this turn (`your-agents-prompt.ts`), and the
reply rule covers whoever messaged you. Neither covers a *sibling* already
waiting on you, which is exactly the case this change created. The mechanism
that would — refusing a message into a session transitively blocked on the
caller — is recorded as unbuilt in [`MAP.md`](MAP.md).

**The policy makes the parent a destination, not a target.** Work goes down to
children, sideways to a sibling only when no child fits, and up to the parent
only as a report or a clarifying question. This shrinks the cycle surface the
previous point widened: with the parent excluded as a task target, an upward
cycle cannot close through it. It is guidance an agent reads, not a rule the
code applies.

**One recipe serves every direction, so its payload is direction-neutral.**
There is one mechanism underneath — a message into an agent's home chat — and
the old `## Hand an agent a task` / `## Who you report to` split organized the
prompt around a reachability distinction that no longer exists. They collapsed
into one list, one `## Reaching one of them` recipe, and a `## Going to your
parent` section owning the blocked-vs-idle fork. The recipe is written against
whichever colleague a ranking picks — a child, else a sibling, else the parent —
and because that last case is real, the payload placeholder is `<message>`. A
`<task>` there would put the forbidden action in the one copyable artifact a
leaf agent has.

**A leaf whose only colleague is its parent still gets taught.** The natural
implementation gates every recipe on having a delegation target, which leaves
exactly that agent with a roster and no instructions — the sections it is the
sole consumer of, withheld. The shipped renderer gates nothing on a delegation
target: the only early return is the genuinely empty roster, and once any
colleague exists the ranking always yields an example, so the one recipe always
renders. The single conditional block is the *parent* section, which appears
when there is a parent.

**There is no row cap.** `MAX_AGENT_ROWS = 30` capped children only, reserved a
slot for the parent, and reported the overflow as a count the HTTP wire never
carried — so the picker showed thirty of N with no way to say so. It was
insurance against an unbounded list, and `MAX_AGENTS_PER_WORKSPACE = 50` already
bounds it at the source, where exceeding it throws. Deleting the cap removed the
arithmetic, the count, the wire field, the prompt's "N more agents are listed
by…" line, and a live defect.

**No compatibility layer.** The gateway auto-updates onto VMs; `apps/api`
proxies the body opaquely and needed no code change. During the update window a
browser on the new schema meets an old gateway and the picker shows "couldn't
reach your workspace" rather than a stale list — the right failure.

## Invariants the code must keep honoring

- **One projection answers "who can this session reach."**
  `readReachableAgentRoster` (`packages/gateway/src/agents/agent-roster-view.ts`)
  owns hierarchy, the lock verdict, the relationship, and the order. Its two
  consumers — `writeYourAgentsPrompt` in `agent-context.ts` and the route in
  `packages/gateway/src/routes/agent-roster.ts` — render what they are handed. A
  third owner is the defect this design exists to prevent.
- **Siblings come from two different places and both must exclude self by
  hand.** A nested agent reads its parent's child list; a top-level agent
  cannot, because its parent is the *synthetic* root member with no `agentId`
  and no entry in `childrenByAgentId`, so its peers are `rootChildren`.
  `groupAgentsByParent` excludes an agent from its own parent search, never from
  its parent's child list.
- **The hierarchy itself has one algorithm**, `groupAgentsByParent` in
  `packages/contract/src/agents/index.ts`. Path-prefix matching exists only
  *inside* it, in `resolveNearestAgent`; no caller re-derives containment from
  paths of its own.
- **A roster with no root member yields no parent at all.** The self row may
  fall back to a default name, because a session must know who it is; inventing
  a parent teaches an agent to report to one that does not exist.
- **`undefined` from the projection is not an empty roster.** Unsynced → 503; an
  agent the roster does not carry → 404; genuinely empty → an empty list.
- **Only the drive root may omit a folder, and it is never a sibling or a
  child.** Collapsing two row shapes into one would have dropped this silently,
  so it survives as a refinement on `AgentRosterRowSchema`. Note where it does
  and does not fire: the gateway route emits the body without parsing it and
  `path` is optional in the inferred type, so a producer bug is caught at the
  first *reader* of the wire (`apps/api/src/gateway/client.ts`), where it fails
  the whole roster into a 502 rather than being rejected at its source.
- **`self` never becomes a delegation target.** It leads the roster and the
  picker; the prompt filters it out before rendering, and `who-you-are.md`
  already owns identity.
- **The worked example never demonstrates an action its own prose forbids.**
  The ranking may reach the parent, so the recipe's payload stays
  direction-neutral.
- **The browser derives nothing about the roster.** `agentRosterRows` in
  `apps/web/spa/sessions/session-agents.ts` maps wire order to picker rows — no
  sort, no relationship of its own, no lock recomputation. Its labels type is
  `Record<AgentRelationship, string> & { awaitingSetup: string }`, so a new
  relationship cannot ship without a badge. What the picker *does* compute is
  the response to typing: `compose-bar-agent-trigger.ts` fuzzy-ranks the same
  rows against the query, so the visible list is not always the gateway's order.
  That is query response, not a second opinion about who is reachable.
- **Row identity is the slug, never the display name.** Names are not unique;
  the product expects two colleagues called "Scout".
- **The relationship badge is outlined, not merely filled.** `bg-muted` is the
  same value as the active row's `bg-accent`, so a fill alone dissolves on
  whichever row the highlight is on.

## Where the code is

| Concern | Entry point |
|---|---|
| Reachable-roster projection | `packages/gateway/src/agents/agent-roster-view.ts` |
| The prompt layer agents read | `packages/gateway/src/agents/your-agents-prompt.ts` |
| Roster over HTTP | `packages/gateway/src/routes/agent-roster.ts`, proxied by `apps/api/src/routes/agent-roster.ts` |
| Relationship vocabulary and wire shape | `AGENT_RELATIONSHIPS`, `AgentRosterResponseSchema` — `packages/contract/src/agents/index.ts` |
| Picker rows and badges | `apps/web/spa/sessions/session-agents.ts` |
| Badge rendering | `ComposeBarMentionPicker`, `packages/ui/src/components/compose-bar/compose-bar-mention-picker.tsx` |
| The live journey this had to keep green | `packages/test-harness/src/staging-e2e-synthetic` |

Behavior is pinned by `agent-roster-view.test.ts` (both sibling branches, order
within groups, no cap), `your-agents-prompt.test.ts` (the parent-only scope, the
example's ranking, the direction-neutral payload), `routes/agent-roster.test.ts`
(the wire, and the 200/503/404 split), `session-agents.test.ts`, and the
`bun ui:check compose-bar` browser gate.

`assets/your-agents-samples.md` renders four scopes through the real renderer
and is pinned to it by `your-agents-samples.test.ts`; it is the artifact to read
when judging prompt wording.

## Divergences from the plan

- **The map put the recipe under `## Hand an agent a task` with a separate
  parent section.** Rendering the parent-only scope showed the shipped prompt's
  "Handing over work is the recipe below" pointing at a section that scope does
  not render — and the first attempt at the parent section added a second such
  promise of its own. Both went away when the sections collapsed into one
  recipe that always renders.
- **The map said the parent is never the recipe's example.** It is, when there
  is nobody else, because reporting upward runs down the same wire as delegating
  downward. The policy moved into the recipe's own lead paragraph instead.
- **That fix nearly shipped with the old `<task>` placeholder**, which put the
  forbidden action — hand your parent a task — into the one copyable artifact a
  leaf agent has, under prose saying the opposite. Nothing in the code enforces
  the policy, so the example *is* the enforcement. Caught by the closing
  decision audit, not by the plan and not by any test; the test that pins it now
  was written afterward. The general rule it left behind is in the invariants
  above.
- **The badge fix was not planned.** An unprimed critique caught the chip
  dissolving into the highlighted row — latent while only self and parent were
  badged, ordinary once every row is.
- **The visual gate was passing stale.** `ui:check compose-bar` was green while
  the baseline bytes were unchanged by a fixture edit that added rows. Force-
  approving revealed the **desktop** compose-bar baselines had been carrying
  sub-threshold drift since `5c0afba1e` deleted the agent-picker control: that
  commit re-approved eleven mobile shots and no desktop ones, so the accepted
  desktop images still showed a control the product had removed. All of them are
  current now.
- **The live journey survived untouched in substance.** It drives root, which
  has no parent and therefore no siblings, so its "a grandchild is absent from
  root's roster" assertion still holds. Only the heading its prompt names
  changed.

## Dead ends

- **Four parallel arrays** (`self`/`parent`/`siblings`/`children`). A smaller
  conceptual diff and more code: both consumers keep re-deriving the label, and
  the overflow count would have needed a sibling twin.
- **Visibility without reachability.** Rejected above — a roster of
  look-but-don't-touch rows, with an open REST route behind it.
- **A proxy that normalizes an old gateway's response shape.** Unnecessary: the
  gateway auto-updates and there is no stored data to convert.
- **A conditional paragraph** for sessions that have no children, so the prompt
  would not lead with a branch that rarely fires. Cut as over-engineering once
  flat workspaces were ruled out of scope.
- **Section headers in the `@` picker** instead of per-row badges. The picker is
  a flat list of buttons whose arrow-key index assumes every item is selectable;
  headers would need a non-row list item and index-skipping.

## Visual provenance

The standard was the surface already in the product: the same picker before this
change, badging only self and parent. `assets/picker-directions.html` is the
four-way comparison the badge treatment was chosen from — badge every row, badge
only the exceptions, section headers, or a bare `↑ ↔ ↓` glyph — rendered against
the real row anatomy with a toggle between a small family and a flat
twenty-one-agent workspace. Direction 1 was chosen.

`compose-bar-agents.png` (desktop and mobile, under
`apps/web/tests/visual/__screenshots__/`) is the accepted result. Note what its
green run does and does not prove: an unchanged baseline means no diff exceeded
the threshold, not that the pixels are identical — this surface had been
carrying invisible drift for exactly that reason. Byte-diff a fresh render
rather than trusting the file.
