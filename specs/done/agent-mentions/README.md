# Agent Mentions

> **Partly superseded by [`../inter-agent-visibility/`](../inter-agent-visibility/README.md).**
> The reachable set now includes **siblings**, the relationship is a field on
> the row rather than which array it arrived in, and the 30-row cap is gone.
> The one-layer reasoning below is the record of why it was drawn there, not a
> rule the code still keeps. Everything else here — the shared projection, the
> tag grammar, row identity, the unknown-vs-empty split — still holds.

Typing `@` in a session composer lists the agents that session can already
reach — the agent you are talking to, its parent, and its direct children — and
picking one writes
`<Agent name="Scout" slug="scout" path="agents/research/scout" />` into the
message. The agent reading it gets the slug every agent-facing API takes, so a
request like "have @Scout pull the pricing pages" carries the address the work
needs. The reader gets a chip that opens that agent's page.

`MAP.md` beside this file is the quadrant walk that preceded the build: the
thirteen decisions (D1–D13) it settled are the givens this shipped against, and
it records three landmines found during slicing. `choices.md` is the decision
ledger — everything the plan left open, decided during the build and re-checked
against the shipped code.

## The reason

**A mention is a pointer, not a command.** The agent already has these
colleagues, and the recipes for handing them work, in its system prompt. Naming
one only says *which* slug the request is about. Nothing is dispatched and no
agent-side code parses the tag — unlike `<Skill …/>`, which the agent runtime
does read as a command, so no agent release was needed here. (The gateway ships
to VMs and does carry the prompt line and the roster route.) `your-agents.md`
says both halves out loud, because an agent that read the tag as "this hands
over the work" would mention a colleague and expect the job to move.

**The set is one layer each way because delegation deadlocks otherwise.** The
mentionable colleagues are exactly a session's parent and direct children — the
same rule `specs/done/agent-delegation/` established, where a message into a
session already blocked waiting on you hangs both sides forever. Mentions
inherit that guard rather than reopening it; a picker that could reach the whole
tree would make the unreachable cycle addressable again.

**The session's own agent is nameable, but is not a colleague.** It rides the
roster as `self`, separate from `children`, and leads the picker badged "You".
Separate because the two mean different things: children are agents work can be
handed to, and an agent that treated itself as one would send work to its own
default session and then wait for a turn it cannot end — the same deadlock the
one-layer rule exists to prevent, aimed at itself. So `self` reaches the picker
and never reaches the prompt's "agents you can delegate to" list; the agent
already knows who it is from its own `who-you-are.md` layer.

**The picker shows what the agent was told, not a second opinion.** The prompt
and the picker read one projection. The tempting shape — an endpoint that
re-derives hierarchy, lock state, order, and cap — is how two surfaces come to
describe different sets of colleagues while both looking correct. The
projection was therefore lifted out of the prompt writer *before* anything
served it over HTTP, so the route never had a chance to grow its own copy.

**"We could not ask" is a different answer from "you have none."** The roster
store used to start empty, so a gateway that had not yet synced was
indistinguishable from a workspace with no agents — and would have stated the
latter as fact. It now starts *unknown*: unsynced answers 503 and the picker
says it could not reach the workspace; only a genuinely empty roster returns an
empty list. This mirrors the invariant the `/` skills picker established.

**Agent matching is stricter than skill matching, deliberately.** `@` is a
character people type in prose about people who are not agents. At the skills
picker's looseness a scattered-letter match sufficed — `@sarah` offered
*Cartographer*, `@dave` offered *Duet* — and because the picker opens with a row
highlighted, a reflexive Enter inserted a colleague nobody had named. Skills keep
the looser default, where an acronym reaching a hyphenated name is the whole
point. The two triggers want different things from the same matcher.

**A word that matches nothing stops being a pick.** The picker holds the Enter
key while open (the composer's send shortcut stands down for it), so staying
open over a non-match meant Enter inserted a line break instead of sending. The
suggestion code had always claimed the closing behavior in a comment; it did not
have it until this feature needed it.

## Invariants

- **One projection answers "who can this session reach."**
  `readReachableAgentRoster` (`packages/gateway/src/agents/agent-roster-view.ts`)
  owns hierarchy, the lock verdict, slug order, and the row cap. Its two
  consumers — `writeYourAgentsPrompt` in `agent-context.ts` and the route in
  `packages/gateway/src/routes/agent-roster.ts` — consume and never recompute.
  A third owner is the defect this design exists to prevent.
- **The hierarchy itself has one algorithm**, `groupAgentsByParent` in
  `packages/contract/src/agents/index.ts`. No path-prefix filtering anywhere.
- **`undefined` from the projection is not an empty roster.** Unsynced → 503;
  an agent the roster does not carry → 404; genuinely empty → an empty list.
  All three legs are pinned at the projection
  (`packages/gateway/src/agents/agent-roster-view.test.ts`) and at the gateway
  route (`packages/gateway/src/routes/agent-roster.test.ts`); the api proxy
  pins the two that are its own job — preserving a 503 rather than flattening
  it, and 404 for an agent it cannot resolve
  (`apps/api/src/routes/agent-roster.test.ts`).
- **The browser computes nothing about the roster.** `agentRosterRows` in
  `apps/web/spa/sessions/session-agents.ts` renders self-then-parent-then-children
  in wire order — no sort, no cap, no lock recomputation.
- **`self` never becomes a delegation target.** It rides the roster and the
  picker; it is absent from the prompt's delegate list, and adding it there
  would hand an agent a way to deadlock against itself.
- **One tag grammar, both ends.** `compose-bar-mention.ts` renders and parses;
  the timeline transform in `apps/web/spa/sessions/session-mention-chips.ts`
  imports it rather than re-parsing. A second parser is the divergence the
  shared codec exists to prevent.
- **One Markdown bridge for all triggers.** Markdown returns a bare tag as a raw
  `html` token and only one extension may claim that token name; a bridge per
  trigger would leave the last one registered owning every tag.
- **Eligibility belongs to the suggestion engine.** `compose-bar-suggestion-rows.ts`
  decides which row the keyboard may land on; the picker displays that verdict
  and never re-checks `disabled` to decide a commit.
- **A picker owns Enter exactly when it has rows to offer.** With rows — even
  rows that are all ineligible — Enter is consumed and commits nothing, so a
  locked colleague cannot be inserted. With no rows at all (an empty roster, or
  one that could not be read) the picker does *not* take the key, because a
  picker holding Enter with nothing to insert turns a send into a line break.
  The guard is `pickerHasRowsRef` in `compose-bar-editor.tsx`, and the
  line-break trap is what the unmatched-mention close and this rule both exist
  to prevent.
- **Row identity is the slug, never the display name.** Names are not unique;
  the product expects two colleagues called "Scout".
- **No `agentId` reaches the browser** — not on the wire, in the tag, in the
  cache key, or in the URL. The one id-speaking hop is api→gateway, which
  already spoke that language.
- **`skipHtml` stays on** in the shared Markdown renderer. It is a safety
  boundary for agent output; the chip transform is the mechanism, not a
  relaxation of it.
- **Agent names exclude `[ ] < > `` ` and control characters** so a name cannot
  break the Markdown link a chip is built from. The VM-sync roster wire tolerates
  a violating row *per row* — one legacy name must never blank every colleague in
  every session's prompt.

## Where the code is

| Concern | Entry point |
|---|---|
| Reachable-roster projection | `packages/gateway/src/agents/agent-roster-view.ts` |
| Roster over HTTP | `packages/gateway/src/routes/agent-roster.ts`, proxied by `apps/api/src/routes/agent-roster.ts` |
| Wire shape | `AgentRosterResponseSchema`, `packages/contract/src/agents/index.ts` |
| The prompt layer agents read | `packages/gateway/src/agents/your-agents-prompt.ts` |
| `@` trigger and tag | `packages/ui/src/components/compose-bar/compose-bar-agent-trigger.ts` |
| Tag grammar | `packages/ui/src/components/compose-bar/compose-bar-mention.ts` |
| Row eligibility | `packages/ui/src/components/compose-bar/compose-bar-suggestion-rows.ts` |
| Roster fetch and rows | `apps/web/spa/sessions/session-agents.ts` |
| Tag → chip in the timeline | `apps/web/spa/sessions/session-mention-chips.ts` |
| Chip rendering and navigation | `SessionAnchor` in `apps/web/spa/sessions/session-markdown.tsx` |

The behavior gate is `bun ui:check compose-bar`, which drives the real editor:
typing `@`, ranking narrowing to the right colleague by slug, Enter inserting a
chip, the exact submitted Markdown, a locked row that the highlight never lands
on and a forced click cannot insert, an unmatched mention falling back to prose,
an empty roster still sending on Enter, and a saved draft restoring as a chip.
Row-stepping over ineligible rows is pinned a level down, in
`compose-bar-suggestion-rows.test.ts`; Tab-as-commit is pinned through the `/`
trigger, which shares the code path. Prompt wording was pinned byte-for-byte by a samples asset until 2026-10-18,
when prompt text became config and the pin was removed.

## Divergences from the plan

- **The roster seam was designed as `{ parent, children }`; it shipped with a
  third field.** Moving the row cap out of the prompt renderer stranded the
  prompt's "N more agents are listed by…" line, which is downstream of the cap.
  The projection returns `hiddenChildren` so the prompt can still say it; the
  HTTP wire drops the count, because the picker has no such line.
- **Three defects were found by review, not by the plan.** Two by the closing
  review: an unmatched mention holding the Enter key, and fuzzy matching
  offering an unrelated agent for a human name. One by the audit that closed
  this spec: a picker with no rows at all — an empty roster — still held Enter,
  turning a send into a line break. All three are behavior only a real editor
  exposes, and all three now have browser tests.
- **The locked-row fork went the primary way.** The plan pre-authorized hiding
  locked colleagues if teaching the suggestion plugin about ineligible rows
  destabilized the Enter-vs-send truce. It did not: eligibility fits entirely
  inside our own suggestion closure, and no vendored plugin was patched.
- **The plan's own riskiest guesses held.** The denylist's read-path blast
  radius, the row-identity collision, and the empty-attribute rendering were all
  named before implementation and all landed as planned — which is worth
  recording precisely because the failures above did not.

## Dead ends

- **A `omitWhenEmpty` descriptor per tag attribute.** More explicit than a single
  omit-empty rule, but it churns `SKILL_TAG`'s type for no behavior change, and
  the parser already defines an absent attribute as empty — so omission cannot
  lose information.
- **A default for the search keys.** `rankItems` requires them, because a default
  of `['name']` would let a future trigger silently widen an existing one by
  omission.
- **Reading the workspace slug from a router hook** in the message renderer. It
  would have returned `undefined` in fixtures with nobody noticing; threading it
  as a prop let the compiler find every call site.
- **A remark plugin replacing the chip fragment scheme.** Still the principled
  fix, still deferred: `#duet-agent=` joins `#duet-skill=` rather than replacing
  the mechanism. The debt was scoped to fire at a third trigger, and this is the
  second.

## Open, and owned by a human

- **No staging or prod sweep has run for names that violate the new rule.** The
  sharp one is `workspaces.duetName`: a violating value fails `whoami`, which is a
  boot failure rather than a degraded list. Fix by data surgery, not migration
  code (pre-launch house rule).
- **The unmatched-query close is a visible change to the shipped `/` picker** —
  typing `/zzz` used to show "No matching skills" and now closes. It matches the
  behavior that code always documented, but it is a change.

## Visual provenance

This feature had no baseline or inspiration imagery to match: the standard was
the `/` skills picker already in the product, and the requirement was that the
two read as one family. `compose-bar-agents.png` (desktop and mobile, under
`apps/web/tests/visual/__screenshots__/`) is the accepted result, and
`compose-bar-skills.png` beside it is what it was judged against.

That skills baseline was never re-approved across this change: it has no commits
on the branch, so the `@` trigger's arrival left the `/` surface's accepted
appearance untouched. Note what that does and does not prove — an unchanged
baseline file means no diff exceeded the threshold, not that the rendered pixels
are identical. Sub-threshold drift passes a green run, so a future change that
means to move this surface should byte-diff a fresh render rather than trust the
file's mtime.
