# Three columns under `/agents`

The agents section has a chat client's shape: the roster on the left, one
agent's conversation in the middle, the card that holds its apps, its folder and
the workspace desktop on the right. The conversation and the card are equal
halves. Bare `/agents` means the default agent's conversation; the drive's
picture of itself keeps an address of its own, reached by an icon in the
roster's head.

**Why:** the section had no navigator. `/agents` was a canvas, an agent was a
page that mounted nothing of the canvas, and the only way from one agent to
another was back out to the picture and in again. A workspace's agents are the
thing a person works *through*, so the list of them belongs on screen while you
work — which is the shape every chat client already has and the reason the
reference below was handed over as the target.

---

## Visual provenance

- [`assets/reference-design.png`](assets/reference-design.png) — the reference
  product the user supplied as the target. It is what "three columns" meant, and
  it drove the roster's position (its column is 22% of that window, which is
  where our 22rem comes from) and the last-message line on each row.

  Duet's version is deliberately **not** a literal copy, and the differences are
  as load-bearing as the likeness:
  - **The equal split is ours, not the reference's.** Measured off that image,
    its two right-hand columns are about 2:1. Equal halves were decided here, on
    the probe below.
  - Our rows carry more than the reference's, so the preview joined the row's
    existing bands rather than replacing the description.
  - The reference has no global top bar; ours keeps one.
  - Two things in it have no counterpart here at all: a "Routines" panel (no such
    feature exists) and a roster search box (declined — see Dead ends).
- [`assets/before/probe-1200-roster-out-5050.jpg`](assets/before/probe-1200-roster-out-5050.jpg)
  and [`probe-1440-…`](assets/before/probe-1440-roster-out-5050.jpg) — the
  column-budget probe, taken against the real app-frame fixture *before* any
  code moved, by constraining the page and forcing an even split. These are the
  evidence behind the width decisions below and the reason the auto-fold band
  sits where it does.
- [`assets/first-three-column-composition.jpg`](assets/first-three-column-composition.jpg)
  — the first working three-column composition in the real shell, before the
  columns were equalised. Its columns measure roughly 405/530.
- [`assets/shipped-front-door.png`](assets/shipped-front-door.png) — what
  actually ships: the section's front door at desktop width, equal halves, with
  the roster standing. This is the current visual baseline, so it moves if the
  composition does.

---

## What must stay true

- **The roster is section furniture, not one destination's.** It stands beside
  both *map* destinations — the graph and an agent — which is what "the section"
  means here. The three other things addressed under `/agents` (an agent's
  settings document, Train, and the marketplace) are full-window destinations and
  deliberately mount no roster; `drive/route-entrance.ts` calls them out as
  outside the section. Nothing structural forces the mount: it is three hand
  written call sites (`agents-map.tsx`, `agent-route.tsx`, and the cold-landing
  shell), and only the agent page's is guarded by a test.

  An earlier attempt mounted it inside an agent folded to zero width and
  `inert` — a roster no reader could open, reach, or see, costing a row of DOM
  per agent. Both failure modes are now prevented by construction
  rather than by care: the column is visible by default, and the section grid
  declares an explicit `minmax(0, 1fr)` row so a long list scrolls inside the
  window instead of sizing it.
- **The roster must be *outside* `.km-page`** — it is that element's uncle, in
  the section grid's other track. `.km-page` is the `km-frame` container the
  agent surface's phone composition queries at 30rem. Nest the roster inside and
  that query measures roster + sheet and fires at the wrong width —
  **silently**, because a container query that never matches raises nothing.
  Guarded by `railInsideTheFrame` in `tests/visual/playground.spec.ts`; counting
  columns through the enclosing `<main>` would pass either way, which is why it
  is asked separately.
- **Only the control writes the reader's preference.** Three things fold the
  column and exactly one is a choice. The window crossing the band does not
  write; nor does a tap that dismisses the panel below `sm`. This shipped wrong
  once — the dismissal used the persisting setter, so a phone tap folded the
  roster on that reader's desktop — and `useRailOpen` now exposes a state-only
  setter that the two involuntary folds spend.
- **`drive/agents-map-url.ts` is the sole owner of the *map* grammar under
  `/agents`** — the graph, an agent, and everything under an agent. Five things
  ask it what such a path means: which tab lights and whether the shell hands
  over the whole window (both `drive/drive-routes.ts`), which skeleton a cold
  landing draws (`spa/loading/loading-route.ts`), whether an arrival should
  animate (`drive/route-entrance.ts`), and the agent route itself. None of them
  may grow a regex for a map path.

  What it does **not** own, by design: the non-map shapes under the same prefix —
  `agents/marketplace`, `agents/:slug/settings`, `…/train`. `drive-routes.ts`
  matches those with a pattern of its own so the Agents tab can light for
  destinations this grammar declines, and `product-destinations.ts` spells every
  route pattern as a literal because it is build-time data with no imports.
- **One route pattern for the agent page.** React Router reconciles by position,
  so two sibling patterns for one element remount it when a path crosses between
  them — which the entry rewrite does on every cold landing, and which a
  persistent roster in that subtree cannot afford.
- **The activity sort's promise.** Every row prints the moment it sorted on, and
  an agent nobody has touched is *absent* from the activity table rather than
  sorting as the epoch — produced as absence in `project.ts`, consumed as an
  alphabetical tail in `roster.ts`, never defaulted to `0`. The graph's row is
  outside the list entirely — it is an icon in the head, not a row, so there is
  no exemption to make. Note the drive's own agent is **not** pinned either: it
  is a row like any other and sorts by its own activity.
- **A row carries exactly one line of prose under the name, never two.** The
  last thing said in that conversation when there is one, and otherwise what the
  agent *is*. Both at once read as a paragraph, and a column of paragraphs is a
  column nobody scans.
- **The control that folds the column is always in flow, never floating.** It
  lives in the head while the column is out and moves to the destination's own
  leading slot when it is away — because the head goes with the column, and one
  absolutely positioned button holding a single position in both states puts a
  square on top of the agent's face the moment the destination has something at
  its top-left corner. Two homes, each in flow, beats one home that overlaps.
- **The preview is never a streaming partial and never the last *event*.**
  Deltas are classified ephemeral and cannot reach the write path — that is an
  invariant pinned by test, not a filter. And a timeline carries tool calls,
  terminal markers and reasoning; the preview walks back to the last thing a
  person would call a message.

---

## The reasoning the code cannot hold

### 50/50 costs the card, not the chat — and the numbers decided the band

The planning walk priced the split on the chat column's 22rem floor. That was the
wrong column. Measured on the real app frame: at a 1200px window the card goes
from ~781px to **409px**, a 48% cut. An unprimed critique of that shot called it
*"a phone column on a desktop… not comfortable to work in"*, which my own
inspection had passed.

The split held, but the auto-fold band's upper bound moved from a guessed 1200 to
**1280**, where the card gets 449px out and 625px folded. That number is a
judgement call and the one thing here most likely to move.

### The identity cluster's restack was a miscalibrated constant, not a cost

The threshold that decides when an agent's face stops sitting beside its name was
*measured* against the old column sizing: three doors need 405px of column in
es-419, which under a 33% clamp arrived at 1227px of container — hence 80rem.

Equal columns make a column `(sheet − 10) / 2`, so the same 405px arrives at
820px of sheet and the crossing moves to 51.25rem. **The shipped threshold is
the round step above it, 52rem** — and the gap between the two matters: a 1200px
window with the roster manually out leaves an 828px sheet, 51.75rem, which 52rem
catches and the bare crossing would not. That case restacks deliberately; its
column clears the requirement by four pixels, which is inside the margin the
threshold exists to provide.

Carried forward unchanged, 80rem restacked the cluster at every desktop width
below about 1650 while it still had two hundred pixels spare. Whoever adds or removes a door re-measures this; **measure the
sheet rather than computing it from the window** — `.km-page` pays its own gap on
both sides, which is a mistake this build made once.

### The last-message preview is materialized, not computed

`agentSessionEvents` stores `event` opaquely with no type column, so finding "the
last message" by reading means an unbounded backwards walk past tool calls — once
per owner, inside a query polled every ten seconds while anything is reading it.
It is written onto the session row instead, at message time, exactly as `bucket`
already is: derived, and materialized only because the alternative cannot be
indexed. The derivation lives in one place and is exhaustive over the event union
with no `default` arm, so a new event type cannot ship without someone deciding
whether it is a message.

### The poll's rate and the ring's refresh edge are two facts

The rate is about *visibility* (is anything reading this) and the edge is about
*navigation* (which boundary was just crossed). They coincided only while the
roster stood beside the canvas alone. A reader on an agent's page with the roster
folded polls slowly, and the edge is the only thing that refreshes the dots when
they leave — so collapsing them, which a draft argued for, would have removed
real behaviour.

---

## Where it lives

| Concept | Owner |
| --- | --- |
| The **map** grammar under `/agents` | `apps/web/spa/drive/agents-map-url.ts` |
| Where the roster stands | `apps/web/spa/routes/agents-map/agents-section.tsx` |
| What goes in the roster | `apps/web/spa/routes/agents-map/roster-column.tsx` |
| The column itself — head, its three controls, the way back when folded | `…/agents-map/agents-rail/index.tsx` |
| Out-ness — preference, band, overrule, and the `sm` dismissal | `apps/web/spa/routes/agents-map/agents-rail/out.ts` |
| The durable preference | `…/agents-rail/open-state.ts` |
| Rows and their sort | `…/agents-rail/roster.ts`, `…/agents-rail/list.tsx` |
| Where a row leads / adding an agent | `…/agents-map/roster-destinations.ts`, `…/agents-map/add-agent.ts` |
| The preview rule | `packages/contract/src/sessions/message-preview.ts` |
| The preview write | `packages/backend/convex/domains/agentSessions/agentSessionsShared.ts` |
| Poll cadence | `apps/web/spa/api/query-options.ts` |
| Column proportions and the restack | `apps/web/spa/knowledge-map/knowledge-map.css` |

Pinned by `…/agents-rail/*.test.*`, `spa/drive/agents-map-url.test.ts`,
`spa/drive/route-entrance.test.ts`, `spa/loading/loading-route.test.ts`,
`spa/routes/route-metadata.test.ts`,
`packages/contract/src/sessions/message-preview.test.ts`, and the Docker visual
suite. The one claim no hermetic fixture can make — a row showing the last thing
said, having crossed a deployed Convex — is
`packages/test-harness/src/staging-e2e-synthetic`.

---

## Dead ends

- **A sibling `chatPreview` field beside `chat`.** It can disagree with the
  session it describes — preview present, session absent, or the reverse. The
  session is enriched instead.
- **Constraining `event: v.any()` and indexing by event type.** Investigated and
  dropped: materializing the preview removes the only thing that index would have
  served. (The reason first given for leaving the column alone was itself wrong —
  the write path already parses the strict union — so do not repeat it.)
- **Two visible markers for who spoke in the preview.** The agent's name as a
  prefix, and a glyph pair. Both were prototyped and discarded before commit, so
  the git history holds neither — what survives is the reasoning, verbatim, in
  `agents-rail/list.tsx`. See
  [`choices.md`](choices.md), which is where the open question lives.
- **Collapsing the ring-freshness edge into the poll rename.** See above.
- **Scoping the shell's entrance wrapper instead of the entrance key.** It would
  put a second owner of the section's shape in the module furthest from it.
- **A roster search box.** Declined with reasoning so it is not re-proposed: the
  workspace ceiling is 50 agents, rows are scannable, and a search box in a
  permanently visible column competes with the sort that is the list's whole
  promise.
- **Splitting the graph's address from the front-door change.** Doing the rename
  alone leaves bare `/agents` meaning something invented for the gap and deleted
  on arrival.

---

## The decision ledger

[`choices.md`](choices.md) records every call this build made that the plan did
not settle, re-audited against the shipped code. Nothing in it is open.

One entry carries a deploy obligation rather than a question: `lastMessage` is a
materialized column whose `author` field changed shape, and this spec carries no
compatibility shims, so the column must be stripped from staging and prod as
part of the deploy. Rows re-materialize on their next message.
