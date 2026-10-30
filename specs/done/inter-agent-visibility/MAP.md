# Inter-agent visibility — quadrant map

The walk that precedes the build. An agent currently sees only its parent and
its direct children — in `your-agents.md` and in the compose bar's `@` picker.
This opens that set to **siblings** (the parent's other children), turns the
relationship into a labelled field, and attaches a delegation *policy* to each
relationship.

Walked 2026-08-16 with Example User. Every decision below was closed in front of him:
`user` = his call, `territory` = the code answered it and he saw the answer.

---

## Known knowns — the settled ground

**The data is already on the VM.** `projectVmTopologyImpl`
(`packages/backend/convex/domains/anchors/model.ts:686`) sends the gateway
*every* live agent in the workspace plus a synthetic `root` member wearing the
workspace's name, bounded by `MAX_AGENTS_PER_WORKSPACE = 50` (it throws past
it). Widening needs **no new query, no VM-sync change, no new plumbing** — it
is a projection change and a rendering change.

**One function narrows it.** `readReachableAgentRoster`
(`packages/gateway/src/agents/agent-roster-view.ts:63`) is the sole owner of
hierarchy, lock verdict, order and cap. Its two consumers —
`writeYourAgentsPrompt` (`agent-context.ts:236`) and the gateway route
(`routes/agent-roster.ts:41`) — render what they are handed and recompute
nothing. That property is why the prompt and the picker cannot describe
different rosters, and it is the property this change must preserve.

**Relationship is positional today.** `{ self, parent, children[] }`, with a row
of `{ slug, name, anchorPath?, locked }`. The prompt expresses relationship as
headings; the picker as `scopeLabel`, an existing per-row badge slot already
carrying "You" and "Parent" (`apps/web/spa/sessions/session-agents.ts:36,46`).

**Slugs are unique per workspace; names are not.** `agents.slug` resolves via
`.unique()` on `by_workspace_and_slug`. The product expects two colleagues
called "Scout", so row identity is the slug and the slug is the row's second
line.

**The one-layer rule was the deadlock guard, and it was always soft.**
Delegation blocks: A POSTs into B's home chat and sits in a 202 retry loop. If a
cycle closes, both sides hang to the 720s ceiling.
`specs/done/agent-delegation/README.md:33` says widening reopens it. But the
prompt already hands agents the escape hatch — when the row cap drops children
it prints *"N more agents are listed by `GET /v1/ws/<ws>/agents`"*, and that
route returns every agent in the workspace, addressable with the API key the
agent already holds. One layer was a **prompt default, not an enforced
boundary**. Widening makes an existing hole the path of least resistance rather
than opening a new one.

**Two-cycles were already reachable.** Today's prompt says *"Any agent listed
above can be handed a task — your parent included, when it is not already
waiting on you."* So `P→S1→P` has always been addressable with prose as the only
guard. Siblings add `P→S1→S2→P`: one hop longer, same class.

**Assumptions carried, unchallenged:** one workspace only; `self` stays badged
"You" and is not a relationship the policy speaks about; onboarding sessions
keep getting the agents layer withheld entirely (`agent-context.ts:473-480`);
the tag grammar `<Agent name slug path />` is untouched.

---

## Known unknowns — the decision ledger

| # | Decision | Closed by |
|---|---|---|
| D1 | Visible set = self + parent + **siblings** (the parent's other children) + children. Not the whole tree — a grandchild still cannot see root's other children. | user |
| D2 | Full reachability, not visibility-only: the listed set is the reachable set. A list where some rows are look-but-don't-touch gets flattened by the model within a turn, and the REST hatch already made the tree reachable. | user |
| D3 | The roster becomes **one ordered array**; `relationship: 'self' \| 'parent' \| 'sibling' \| 'child'` is a field on the row. Wire is `{ rows: [...] }`. The label is a decision, and decisions have one owner — that is the invariant the shared projection exists to hold. | user |
| D4 | **No back-compat, no migrations, no versioning.** The gateway auto-updates. `apps/api` needs no code change (it proxies opaquely) though its client validates the shared schema. | user |
| D5 | **Delete `MAX_AGENT_ROWS`**, the hidden count, the wire field, and the prompt's "N more agents…" line. `MAX_AGENTS_PER_WORKSPACE = 50` bounds it at the source. Also kills a live defect: the HTTP wire never carried the overflow count, so the picker showed 30 of N with no way to say so. | user |
| D6 | Relationship carries **policy**. Delegate **down** to children. Go **up** only to report or ask a clarifying question — never to assign work. Go **sideways** to a sibling only when the work belongs to no child of yours. | user |
| D7 | The prompt drops `## Who you report to` and `## Agents you can delegate to`. One list, the policy in a prose paragraph, and a `## Going to your parent` section covering the blocked-vs-idle fork. Under D2 those headings split by a distinction that no longer exists. | user |
| D8 | Order is **structural**: self → parent → siblings → children, slug order within each group. One order serves both surfaces; nothing re-sorts downstream. | user |
| D9 | A locked sibling is treated exactly like a locked child — listed, flagged *awaiting onboarding*, not insertable. Same predicate, no new branch. | user |
| D10 | The word is `sibling`, in both the prompt row and the picker badge. | user |
| D11 | Picker renders **direction 1**: a relationship badge on every row, in the `scopeLabel` slot that already exists. Children get a badge for the first time. The second line stays the slug, not the path. | user |
| D12 | **No new staging journey.** Closeout is unit tests plus `bun ui:check compose-bar`. | user |
| D13 | Audience is **both** — an agent reaching a peer, and a person naming one in the composer. | user |
| D14 | Ships to **staging**; prod promotion is a separate call. House default, recorded rather than asked. | assumed |
| — | Two top-level agents **are** siblings: `groupAgentsByParent` puts every agent no other agent encloses into `rootChildren`, and the projection already falls back to the synthetic root member as their parent (`agent-roster-view.ts:99-108`). Root is a real parent for this purpose, no special case. | territory |
| — | "Report to parent" has two existing mechanisms and the split is exactly what D6 needs. **Parent called you** → its session is blocked; the correct move is ending your turn with an `ask` terminal (`your-agents-prompt.ts:123-132`). **Parent idle** → the same blocking POST as delegation, aimed at its home chat. So "report, don't assign" is prose over one verb; nothing enforces it. | territory |
| — | `parent-session.md` is session lineage, not the parent *agent*, and already owns the blocked-parent rule for its own case. Out of scope. | territory |

### Considered and not taken

- **Visibility without reachability** (list everyone, delegate to one layer).
  Rejected: a roster where two-thirds of rows are unaddressable is a
  distinction models flatten, and the REST hatch means it buys no real safety.
- **A wait-graph guard** that refuses a message into a session transitively
  blocked on the caller — the only shape in which unrestricted reach is *safe*
  rather than merely honest. Deferred as a separate slice; nothing tracks the
  wait graph today.
- **Four parallel arrays** (`self`/`parent`/`siblings`/`children`). Smaller
  conceptual diff, more code: both consumers keep re-deriving the label, and
  `hiddenChildren` would need a sibling twin.
- **A proxy that normalizes old gateway responses.** Killed by D4.
- **A conditional paragraph** for sessions with no children. Killed as
  over-engineering.

---

## Unknown knowns — what got extracted

**Real workspaces are flat by construction, and that is deliberately not a
constraint here.** Every product surface creates `agents/<slug>`: the UI
hard-codes it (`apps/web/spa/agents/create-agent.ts:101`, with no parent-folder
input in the Add-Agent dialog), marketplace and hub installs use
`marketplaceAgentInstallPath` (`packages/contract/src/marketplace/index.ts:108`),
and all 24 official seed entries are `agents/<slug>`. No "create sub-agent"
flow exists; `start-session` spawns sessions, not agents. Nesting arises only
from a caller-supplied `path` (unvalidated — `RegisterAgentRequestSchema.path`
is any non-empty string) or a share mounted into a nested folder.

So today siblings ≈ every agent in the workspace, and D1's narrowing changes
nothing in practice. **Example User's call: build for the hierarchy that is coming, not
the flat shape that exists.** Recorded so a future reader does not re-derive the
observation and mistake it for a defect.

**The taste that came out of the mock:** the relationship should be stated
plainly on every row rather than implied by absence, position, or a glyph. The
badge is a label, not a warning — uniformity beats signal here.

**The bar for this change is "easy".** Stated directly: no new journeys, no new
picker primitives, the least code that does the job. Section headers in the
picker were rejected on that ground alone.

---

## Unknown unknowns — landmine cards

### ① The naive edit strips the parent recipes from leaf agents — **must fix**

`your-agents-prompt.ts:25` picks the delegation example as
`children.find(!locked) ?? parent ?? children[0]`, and `:55` returns early when
it is `undefined`, skipping **every** recipe section. Under D6 the parent can no
longer be the example, so an agent with a parent and no siblings or children
yields `undefined` and loses the parent recipes — the sections it is the only
consumer of. Today that case gets the full set precisely because parent counted.

*Changes the task:* the fix is structural. The delegation example gates only the
delegation recipe; parent sections render whenever a parent exists.

### ② Siblings do not come from `childrenByAgentId` — **must fix**

For a top-level agent the parent is the *synthetic* root member: no `agentId`, no
entry in `childrenByAgentId`. Siblings there are `hierarchy.rootChildren` minus
self. Only a nested agent reads `childrenByAgentId.get(parentAgentId)` minus
self. **Both branches must exclude self by hand** — `groupAgentsByParent` is
self-excluding for parents, not for this. The repo already paid for the
neighbouring mistake: `resolveNearestAgent` counts an exact path match as a hit,
so a naive reuse renders every roster empty and says nothing, which is why that
helper's first test is the negative.

### ③ The visual gate cannot see the change unless the fixture does — **must fix**

`apps/web/components/playground/compose-bar-playground.tsx:580-612` builds its
three scenes from hand-written `ComposeBarAgent[]` containing no sibling or child
row. `bun ui:check compose-bar` would pass green while never rendering the new
badge. Scenes gain sibling and child rows; the baseline moves, and it is
force-approved with a byte-diff — sub-threshold masking has bitten this exact
surface twice.

### ④ The live journey references a heading being deleted — **must fix**

`packages/test-harness/src/staging-e2e-synthetic:113` asks the model
to list slugs *"from the 'Agents you can delegate to' section"*, which D7
removes. Local gates never execute staging journeys, so this rots silently. It
is updated in the same change even though D12 says we do not run it.

Note the journey's *assertion* survives untouched: it drives root, which has no
parent and therefore gains no siblings, and `scout-helper` stays a grandchild of
root and stays absent.

### ⑤ The lock verdict now scales with the roster — **sharp edge**

`readContainedDriveFile` does four synchronous fs calls per row
(`realpathSync`, `statSync`, `accessSync`, `readFileSync` —
`packages/gateway/src/agents/contained-drive-file.ts`) to read each agent's
`agent.json`. The prompt is regenerated every turn. Going from ~2 rows to a full
family multiplies that. Small in absolute terms; it now grows with the list.

### ⑥ The update window shows "couldn't reach your workspace" — **sharp edge**

`apps/api/src/gateway/client.ts:714` hard-validates against
`AgentRosterResponseSchema` and returns 502 on mismatch. Browser and api deploy
instantly; the gateway follows on its VM poll. In between, the picker shows the
unavailable state rather than a stale list. That is the right failure — noted so
it is not mistaken for a defect.

### ⑦ Nothing enforces D6 — **sharp edge**

"Report up, don't assign up" is prose. Mechanically, reporting to an idle parent
and delegating to it are the same POST. An agent that ignores the paragraph gets
no error.

---

## Open, and owned by a human

- **The wait-graph guard.** The only mechanism that would make unrestricted
  reach safe rather than merely honest. Unblocked by someone deciding it is
  worth tracking the blocked-on graph; until then the guard is a sentence in a
  prompt.
- **`manage-agents` gives no nesting guidance.**
  `packages/skills-registry/skills/manage-agents/SKILL.md:52` tells an agent to
  "choose a drive-relative folder" with no reason to nest. It is the only thing
  that can produce the hierarchy D1 is built for. Whether it should start
  recommending nesting is a separate call.

## Confirm before coding

- `es-419` wording for the two new labels: *Par* (sibling) and *Subordinado*
  (child), beside the existing *Superior* (parent).
- `specs/done/inter-agent-visibility/assets/your-agents-samples.md` is regenerated in
  place — an artifact inside a closed rationale record, pinned by
  `your-agents-samples.test.ts`.

---

## The shape it lands in

```ts
// packages/contract/src/agents/index.ts
type AgentRelationship = 'self' | 'parent' | 'sibling' | 'child'
interface AgentRosterRow {
  slug: string; name: string; anchorPath?: string
  locked: boolean; relationship: AgentRelationship
}
// packages/gateway/src/agents/agent-roster-view.ts
interface ReachableAgentRoster { rows: readonly AgentRosterRow[] }  // ordered per D8
// wire
{ rows: [{ slug, name, path?, locked, relationship }] }
```

`your-agents.md`, as rendered:

````markdown
# Your agents

The agents you can reach from this session, as of this turn.

Prefer the agents you have a direct relationship with. Hand work down to your
children — that is what they are for. Go to your parent to report progress or
ask a clarifying question, never to hand it a task. Reach sideways to a sibling
only when the work belongs to no child of yours.

- **Duet** (`root`) — parent
- **Analyst** (`analyst`) — sibling — `agents/analyst`
- **Drafter** (`drafter`) — sibling — `agents/drafter` — awaiting onboarding; ask the user to set it up before delegating
- **Helper** (`scout-helper`) — child — `agents/scout/helper`

## Naming one of them in a message
…unchanged…

## Hand an agent a task

A child of yours, or a sibling when the work belongs to no child of yours.
Never your parent.
…recipe unchanged…

## Going to your parent

If your parent's message is what started this turn, it is blocked waiting for
your turn to end — a message back will never be read. End your turn by asking;
your question resolves its wait, and the answer arrives as your next turn.
Otherwise reach its home chat with the recipe above — to report or to ask, not
to hand it work.
````

## Files this touches

| Concern | File |
|---|---|
| Projection + sibling computation | `packages/gateway/src/agents/agent-roster-view.ts` |
| Prompt renderer (+ landmine ①) | `packages/gateway/src/agents/your-agents-prompt.ts` |
| Sample harness + regenerated asset | `packages/gateway/src/agents/your-agents-samples.ts`, `specs/done/inter-agent-visibility/assets/your-agents-samples.md` |
| Gateway route serializer | `packages/gateway/src/routes/agent-roster.ts` |
| Wire + row schemas | `packages/contract/src/agents/index.ts` |
| Picker rows + labels | `apps/web/spa/sessions/session-agents.ts` |
| Locale strings | `apps/web/messages/{en,es-419}/app.json` |
| Visual fixture (landmine ③) | `apps/web/components/playground/compose-bar-playground.tsx` |
| Journey prompt string (landmine ④) | `packages/test-harness/src/staging-e2e-synthetic` |
| Tests keyed on the old shape | `agent-roster-view.test.ts`, `your-agents-prompt.test.ts`, `routes/agent-roster.test.ts`, `session-agents.test.ts`, `packages/contract/src/agents/index.test.ts` |

`apps/api` needs no code change: the route proxies opaquely and its client
validates the shared schema, which moves with the contract.
