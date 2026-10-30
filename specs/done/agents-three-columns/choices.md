# Choices — the final ledger

Every decision this build made that the spec did not settle, re-audited against
the **shipped code** rather than against the pass it landed in. Provisional
calls have been collapsed to what actually shipped, entries a later pass
reverted are gone, and duplicates are merged.

Grouped by verdict, least-confident first — read the top of this file and stop
when you stop disagreeing.

---

## Reversed after seeing it ship

Five calls were overturned once the built thing was in front of the user. They
are entries rather than a footnote because the reasoning that *lost* is what a
future reader would otherwise re-derive from scratch.

### The row shows one line of prose, not two

**When** — after the close, commit `015eeebd1`.

**The choice.** A roster row has a name, and under it prose. It shipped with
*two* lines of prose: what the agent is (the first sentence of its own
`AGENTS.md` — a "description") and, under a hairline rule, the last thing said
in your conversation with it (the "preview"). Both were true, and the user's
call at planning time was explicitly additive: keep every band the row already
had, and add the message.

Walk it. You open the workspace and the column has six agents in it.
`product-manager` shows *"Turns a vague product idea into a buildable spec with
explicit scope, named unknowns,…"* wrapped onto two lines, a hairline, then
*"yo"*. The next row does the same with its own two sentences. Six rows of that
is six paragraphs, and the eye stops reading any of them.

Today the row picks one: the message when there is one, the description
otherwise. `product-manager` shows *"yo"*. An agent nobody has written to still
introduces itself.

**The gap.** The plan settled the field shape and that the preview joined the
row rather than replacing the description. It did not ask what a column of them
looks like — which is a question only the built thing can answer.

**The reach.** The description is now invisible for any agent you have ever
talked to. If a reader ever needs "what is this agent" at a glance while also
seeing recent activity, that is a new affordance rather than a CSS change —
there is no second slot any more.

**Verdict — sound.** The user reversed it on sight of the built column, which is
the strongest evidence available. **Confidence — high.**

### The graph is an icon in the head, not a row in the list

**When** — after the close, commit `015eeebd1`.

**The choice.** The drive's picture of itself (the "graph" — a canvas showing
every agent and app as a ring) needs a door. It shipped as a pinned row at the
top of the roster: a dashed glyph, the word "Graph", and a second line reading
*"Every agent and app, drawn"*.

That put a thing which is not an agent at the head of a list of agents, and
spent a line of prose explaining that it is not one. It also had to sit outside
the `<ul>` the agents are in, because the list sorts by recent activity and the
graph has no activity to sort on.

Today it is a 28px icon button in the roster's head, immediately left of the
add-agent `+`. The two read as a pair: the two things you can do from this head.

**The gap.** The plan asked *where in the column* the graph's row goes (top or
bottom) and settled "top". It never asked whether it should be a row at all.

**The reach.** The head is now a three-control row — fold, graph, add. A fourth
door into the section has nowhere obvious to go and will force a decision about
overflow.

**Verdict — sound.** **Confidence — high.**

### The head lost its subtitle

**When** — after the close, commit `015eeebd1`.

**The choice.** The column's head read "Agents" with *"Most recently active
first."* beneath it. That sentence explains the sort order — and every row
already prints the moment it was sorted on ("4 min ago", "in 4 hrs"), so the
order is checkable from the rows themselves. As furniture that is always on
screen, a standing explanation is a line you read once and step over forever.
Deleted.

**The gap.** The plan carried the subtitle over from the column's previous life
as a drawer that opened for a moment, where saying what the list *was* earned
its space.

**The reach.** None beyond the string. Both locale catalogues keep the key.

**Verdict — sound.** **Confidence — high.**

### The fold control stands in flow, in two homes, rather than floating in one

**When** — after the close, commit `015eeebd1`. This one went further than the
user asked, so it is the entry to read hardest.

**The choice.** The control that folds the roster was a single absolutely
positioned button — `position: absolute; left: 20px; top: (topbar + 10px)` —
holding that one spot whether the column was out or away. The argument for one
fixed position was that the column then reads as folding *into* the button.

It works over a canvas, which is where it was designed. It fails the moment the
column folds beside an *agent*, because an agent's page has its own face at that
exact corner: the button lands on top of the avatar, half-covering it. That is
the state the user photographed.

The user asked for the collision to be fixed by moving the control into the slot
the back-arrow was vacating. What shipped goes one step further: the control is
**in flow in both states**, not just the folded one. Out, it is the first item in
the head's control row. Folded, the head has gone with the column, so the
destination beside it places the control in its own leading slot — the agent's
well for an agent, and over the canvas for the graph, which has nothing at that
corner to collide with.

The alternative, and the reason this is worth flagging: keep the single absolute
position and simply move it (down, or right) so it clears the avatar. That
preserves "one control, one position" and is a smaller change. It was rejected
because any fixed offset is a bet that no destination will ever put anything at
that corner, and this feature had just proved that bet loses.

**The gap.** The plan's decision 13 said the control lives in the roster head,
and separately assumed one position. Those two are incompatible the moment the
head can be off-screen — the plan never noticed.

**The reach.** Two homes means any *new* destination in the section must place
the control itself when the column is folded, or it will have no way back. There
is nothing structural forcing that — it is a prop a route can forget to pass.

**Verdict — sound, but the widened scope is the user's to confirm.**
**Confidence — medium**: the collision fix was asked for; making both states
in-flow was my call, and a reader who valued the single-position rule more than
I did would have moved the offset instead.

### The back-arrow out of an agent is deleted

**When** — after the close, commit `015eeebd1`.

**The choice.** Every agent's page carried a small circular `←` tucked against
its avatar — the way back to the drive's picture of itself. It is gone, and the
slot it held is where the fold control now stands when the column is away.

Walk it. You are reading `data-analyst`. Previously: click `←` to go out to the
canvas, then click another face to go somewhere else. Today: the roster is
already beside you, so you click the row you want — or the graph icon in the
head if the picture is what you wanted. The journey the arrow made is one click
either way, and it is a click you can aim at your destination rather than at a
waypoint.

**The gap.** The plan never listed `LeaveAgent` as something the roster made
redundant. The user identified it.

**The reach.** With the column folded *and* the reader inside an agent, the only
way out is the fold control — open the column, then pick. That is one more click
than the arrow was, in the one state where the arrow was most useful.
`LeaveAgent` and its `.km-leave` styles are deleted rather than left orphaned,
so restoring it is a revert rather than an un-hide.

**Verdict — sound.** **Confidence — medium-high**: the user asked for it
directly, but the folded-inside-an-agent case is genuinely one click worse and
nobody has used it in anger yet.

---

## Judgement calls — reasonable, but a different answer was available

### The restack threshold is 52rem, and the one case it still catches is deliberate

`@container (max-width: 80rem)` decided when an agent's face stops sitting
beside its name. It was *measured*: three doors need 405px of column in Spanish,
and under the old column sizing that arrived at 1227px of container.

Equal columns make a column `(sheet − 10) / 2`, so the same 405px arrives at
820px — the crossing moves 76.7rem → 51.25rem, and the threshold to **52rem**.
Carrying 80rem forward would have restacked the cluster at every desktop width
while it still had two hundred pixels to spare; an unprimed critique of that
state called it "reflowed, not composed" with no context at all.

The shipped threshold is the round step above the crossing, **52rem**. One case
still stacks: a 1200px window with the roster manually pulled out is an 828px
sheet and a 409px column — four pixels over the requirement, which is
*inside* the margin the threshold exists to provide. A reader who overrules the
fold below the band has asked for a cramped layout. Every width the product
reaches by default is clear: at 1280 the column is 449px.

**Re-derive rather than nudge** if this moves, and measure the sheet rather than
computing it from the window — I got that wrong once by forgetting `.km-page`
pays its own gap on both sides.

### The fold takes three facts, not the two the spec named

The spec's owner table said `railIsOut({ open, cramped })`. Two facts cannot
express the state a reader in a small window actually wants: *"I know it's
tight, show me the roster anyway."* With only two, either the auto-fold wins
forever and the control does nothing inside the band, or the preference wins
forever and the auto-fold never fires.

So there is a third, `said`: has the reader touched the control since the window
last crossed the band? Until they have, the window decides; once they have, they
do. It is component state, not storage, and it resets on the crossing — "out at
1100" is an answer about *that window*, not a new preference.

### Every session carries a preview, not only the ones that are somebody's chat

`appendEvent` stamps `lastMessage` on any session it stores a message for, but
only the owner's *chat* is ever read for it. Job sessions therefore carry a
column nothing renders.

The alternative was reading the owner's default-chat pointer on the hottest
write path in the product to decide whether to bother. Writing unconditionally
costs a field in the same transaction that was already patching the row; reading
first costs a lookup on every message forever.

### A message with nothing left after flattening is not a message

Markdown is flattened before truncation, so a message that is *only* a fenced
code block flattens to nothing. That previews as **absent**, not as an empty
band — the row then looks like an agent nobody has written to, which is not
quite true.

The alternative, a placeholder like "(code)", invents a word the reader never
said. Absent is the state the row already draws correctly and the one that
cannot be mistaken for content.

### The preview bounds an empty string but deliberately not a long one

`text` has `.min(1)` and **no** `.max()`. The server owns the cut
(`CHAT_PREVIEW_MAX`), so a max on the read side would mean that *lowering* that
constant later rejects the whole activity response for every row written under
the old one — one workspace's history taking out the entire roster.

### The graph's control is an anchor, not a button

**The choice.** The graph is a place with an address (`/w/:ws/agents/graph`), so
its control in the roster's head renders as `<a href>` rather than `<button>`,
and its click handler bails out on modified clicks — cmd-click, ctrl-click,
shift-click, middle-click — letting the browser do what it always does.

Walk it: you cmd-click the graph icon expecting a new tab. With a `<button>` you
get nothing, because a button has no href for the browser to act on, and the
handler would have navigated the current tab instead. This is the one place in
the product where that would have been true.

**The reach.** Anything else added to that head which is a *place* must be an
anchor too; anything which is an *action* (the `+`) stays a button.

**Verdict — sound. Confidence — high.**

### The section's entrance key is its own word, not the `agents` tab

Clicking a roster row must not replay the shell's arrival animation, so every
path in the section collapses to one key. That key is `'agents-section'` rather
than the tab's string — because an agent's settings document and Train both
light the `agents` tab and are *not* map paths, so reusing it would have
silently cost those two pages their entrance. They replace the whole window and
genuinely are arrivals.

### `useAddAgent` hands back a `dialog` bag rather than six props

Adding an agent is four things that always travel together: the control, the
taken-slug read, what a confirmed creation does to the cache, and where it goes
after. The hook returns `{ onAddAgent, dialog }` and a host spreads `dialog`
onto the dialog. Six named props read the same on one host and get worse on
each new one — and the whole reason this is a module is that there are two.

### The folded-beside-an-agent state got a fixture of its own

**When** — after the close, commit `015eeebd1`.

**The choice.** The roster's playground had four pictures: the canvas with the
column away, the column out beside the canvas, the agent's page, and the rows on
their own. None of them showed *the column folded beside an agent* — which is
exactly the state the collision above lived in, and the state where a reader with
no visible control has no way back to a second agent.

It now has a fifth, `agents-rail-inside-folded`, and the user asked for it by
name. While adding it I also found the fourth picture (`agents-rail-inside`) was
mounting a bare agent page with **no roster at all** — it predated this feature
and had never been brought along, so it was photographing a composition the
product does not have. It draws the real section now.

**The reach.** Five fixtures for one column is a lot of Docker time. If a sixth
state appears, the right move is probably a states-grid like the one the rows
already use, rather than a sixth full-page shot.

**Verdict — sound. Confidence — high.**

### The phone's front-door baseline photographs the door, not the panel

The mobile shot was settling on the roster, which below `sm` means *opening* it
— so the picture was the list covering the front door under a baseline named for
the front door. An unprimed critique of that image reported the bottom 40% of
the phone as empty with no conversation. It settles on the agent's own sheet
now, which is true at every width and requires opening nothing.

### `AgentsHome`'s deletion moved earlier than planned

Slice 04 was to delete the phone's list page alongside the front-door change.
Mounting the section from the agent route removed its last mount one slice
earlier, and an unreferenced file that a coverage gate then flags is worse than
one deletion arriving early. What replaces it was already settled: the graph
draws at every width, and the roster is the full-width panel the column already
becomes below `sm`.

### The contract grew a leaf module to break an import cycle

`sessions/index.ts` must import `message-preview.ts` for the wire type, so the
preview importing `sessionTitleExcerpt` back out of `index.ts` is a TDZ crash
depending on load order. The shared cut moved to a new leaf, `sessions/excerpt.ts`;
`sessionTitleExcerpt` keeps its name, default and callers.

### The preview fixture lives on the roster's own playground

Rather than on the shared drive fixture, so adding a preview does not move the
canvas's baselines for a change the canvas cannot show.

---

## Settled — these would be hard to argue with

### The roster row names the person who spoke

You type "escalate anything still open from Friday" into Support Triage's chat.
Within a poll its roster row on the left reads **Ada Lovelace: escalate anything
still open from Friday**. Support Triage answers, and the row becomes its reply
with no prefix at all. The *absence* of a name is what says "the agent" — so the
two voices are told apart without spending a second line or a glyph on it.

The first build shipped nothing visible here. Two markers had been tried and
both failed an unprimed review: the agent's own name as a prefix (redundant
fifteen pixels directly under the same name, eating two fifths of a line that
was already truncating) and a 12px paper-plane/speech-bubble pair (at 1x both
collapse into a dark dot in the *same left column* as the job rows' status dots,
so the band read as the first job). What neither attempt tried was the thing a
reader actually wants: not which *side* spoke, but *who*.

"Who" was unavailable because of a contract, not a layout. The **contract** is
the shape of the data the backend writes and the frontend reads — here
`MessagePreview` in `packages/contract/src/sessions/message-preview.ts`. Its
`author` field was an enum of exactly two strings, `'user' | 'agent'`, so the
row could not have named a person even if it wanted to. And a workspace has
several members, which is why the obvious `"You: ..."` was never available
either: the reader is not necessarily the one who spoke.

So `author` grew from that enum into a **discriminated union** — a value that
carries a `kind` tag telling you which shape the rest of it takes:

    { kind: 'agent' }                     // the agent itself
    | { kind: 'user',    userId }         // a person
    | { kind: 'app',     appId, ... }     // an app acting on its own
    | { kind: 'session', sessionId, ... } // a sibling session
    | { kind: 'system' }

The four non-agent shapes are not invented for the roster. They are
`SessionInputSenderSchema`, the union the session journal already stores for
every inbound message, spliced in whole. The preview now records whatever the
journal recorded, so the row can never disagree with the transcript.

**Ids are stored, names are resolved at read time.** The row is handed a
`memberName(userId)` lookup by `roster-column.tsx`, which reads the workspace's
member list; `speaker()` in `agents-rail/list.tsx` calls it. Rename someone and
the roster says the new name on the next read, with no backfill, because the
stored row never held a display name to go stale. Only `kind: 'user'` resolves
to a prefix today — an app or a sibling session falls through to no prefix, the
same as the agent — but the seam is there the day those should be named.

**The reach.** A fifth sender kind has to land in three places at once, and
missing the middle one is the classic way this breaks: the zod schema
(`MessagePreviewAuthorSchema`), the Convex argument validator
(`messagePreviewAuthorValidator`, `packages/backend/convex/validators.ts`), and
`speaker()`. The validator is a *second* schema that Convex enforces at the
function boundary; a field that reaches the zod side alone makes the sync 500.

**A deploy note that is not optional.** `lastMessage` is a *materialized*
column — written onto the session row when a message lands, not computed when
the roster is read. Every row written before this change holds `author: 'user'`,
a bare string where the validator now demands an object. This spec carries no
compatibility shims by rule, so the column has to be stripped from staging and
prod as part of the deploy; each row re-materializes on its next message.

### The agent page has one `main`, and every panel under it is a `div`

A **landmark** is a signpost a screen reader offers as a jump target. The one
called "main" means *this is the page's content*, and a page is supposed to
have exactly one.

Walk it. You open `research`'s page with a screen reader and ask for the
landmarks. `agents-section` — the element that draws the roster beside the
agent's sheet — owns the page's `main`, correctly; `agent-page` says so in a
comment and draws none of its own. But the session surface under it drew five,
one per panel it can show: the spinner while the owner resolves, the day-one
chat, the pending-create shell, the live conversation, and the "agent
unavailable" message. Ask for "main" and you were handed a menu.

All five are `div`s now, and the rule that picked that tag over `section` is
worth keeping: a `section` only *becomes* a landmark when it carries an
accessible name, and none of these five has one. An unnamed `section` is a
`generic` box that some readers still announce, so it would have traded a wrong
landmark for noise. The names on this surface already live on the parts that
have them — the transcript is a `role="log"` called "Session timeline", the app
column beside it is an `aside` named after its app, and the waits are labelled
`section`s inside `SessionDetailSkeleton`.

The count found a sixth the audit had missed, and it is the interesting one.
The drive card on the same page also drew a `main` — and *on the drive's own
route that is correct*, because there the drive is the page. `FilesSurface`
already knew which it was: `chrome` is the prop that tells it whether it is a
whole page or a guest, and the toolbar had been reading it all along. So it
keeps `main` where it is the page and becomes a `section` where it is a card,
carrying the "Drive" name it always had either way — the one element here that
earns a named landmark.

What the tag used to do for anything that had to *find* the conversation
column, `data-session-conversation` does now: all three of its shells wear it,
so the composer's geometry assertions measure the same box whichever is on
screen. The invariant is pinned beside the roster's own counts in
`tests/visual/playground.spec.ts` — the agent page is counted for `main`
elements and fails at two.

### Only the control writes the reader's preference; two other folds do not

Three things fold the column and exactly one is a choice. The **control** writes
to storage. The **window** crossing the band does not — a resize is not the
reader deciding how they like to work. And below `sm`, where the column covers
what it sends you to, **picking a row** dismisses it and does not write either.

That last one shipped wrong first: the dismissal called the persisting setter,
so a phone tap stored "shut" and the reader's laptop opened to a folded roster
on the front door. `useRailOpen` now exposes a second, state-only setter that
the two involuntary folds spend, and a test fails if the persisting one comes
back.

### The storage key rotated instead of being migrated

`duet.agents-rail-open` → `duet.agents-roster-open`, with nothing reading the
old one. Values under it were written when a desktop click was inert and the
column only appeared while hovered — answers about a control that no longer
exists. Honouring them would fold the roster on the new front door for readers
who never asked. The old key ages out with the browsers holding it.

### The poll's rate and the ring's refresh edge stay two facts

A draft argued the "you just left an agent, re-ask" edge is redundant once the
roster polls fast everywhere. It is not. The **rate** is about visibility (is
anything reading this) and is now `liveActivity`; the **edge** is about
navigation (which boundary was just crossed) and is still `unfolded`. They
coincided only while the roster stood beside the canvas alone — a reader on an
agent's page with the roster *folded* polls slowly, and the edge is the only
thing that refreshes the dots when they leave.

### Slices 03 and 04 landed as one pass

Separating them would have left bare `/agents` meaning something invented for
the gap and deleted on arrival — the short-lived seam this spec's own firewall
forbids. The graph's segment has to exist before the bare path can mean anything
else; they are one change with two halves.

### `agentPage` is one route pattern

It declared two siblings, and React Router reconciles by position — so the entry
rewrite crossed between them and remounted the destination on every cold
landing. Harmless when the page was the whole window; not harmless with a
persistent roster in that subtree. (This shipped wrong once too, under a comment
saying it had been fixed.)

### A reserved word can also be a place, and the test says so precisely

`RESERVED_AGENT_SLUGS` used to guarantee "these are not places" — true while
every member belonged to another route. `graph` is the first that is **both**:
reserved so no agent can take the name, and answered so the shell, the tab and
the skeleton recognise it. Reserved-only would have broken all three silently.
The existing test would have had to be *weakened* to let it through, so it was
sharpened instead: **no reserved word can ever be read as an agent**, checked by
feeding each one an agent-shaped tail.

### The roster is assembled once, and the fold is resolved by the route

`useRosterColumn` builds the column so the graph and an agent cannot build it
two ways; only two arguments differ (which row is marked, where a hover is
reported). The fold is resolved by each route and passed *in* — it has to be, because
on an agent's page the roster's out-ness decides the activity read's cadence, so
the route needs the answer before it calls `useWorkspaceMap`, and that hook
needs the map. Resolving it inside would be circular; calling it twice would
give two copies of one preference.

### `useRosterDestinations` navigates itself

Both hosts would pass an identical `onNavigate`, so the parameter would exist
only to let them differ — and "where a roster row leads" is exactly what must
not differ between the two surfaces. Every answer is still built through
`agentsMapUrl`, so the grammar keeps its single owner.

### The roster's per-row `AGENTS.md` reads are warmed, and the exception is written down

Each row reads its agent's description, and its old safety argument ("the rows
only exist while the drawer is open") died when the column became permanent.
Rather than gate the reads, they joined the preload's existing bounded burst,
which already warms the other half of the same profile. The price is stated
rather than absorbed: an owner goes from four concurrent reads to five, so a
full batch peaks at 20 instead of 16 — and because that module's header records
it as a sanctioned exception to a fan-out rule, the new scope is written into
the three docs that describe it.

### The activity cache merges rather than replaces on an optimistic frame

The browser's session cache overwrote an owner's cached `chat` with a
client-authored summary on every optimistic frame. Since that summary has no
`preview`, the new band blanked the instant a reader typed and returned on the
next poll. It merges now. This was a defect the spec's owner table missed —
it stopped at the row and never named the cache patchers.

### The cold skeleton draws the roster, from the column's own geometry

The pre-identity shell drew the sheet alone, so identity landing jumped the
whole sheet 22rem. It mounts the same section with the roster's **own**
`SkeletonRows`, and the width and head padding come from the column it stands in
for rather than being re-spelled — a skeleton one bar-height off is exactly the
jump it exists to prevent.

---

## Trivial discretion

`CHAT_PREVIEW_MAX = 150`. `ROSTER_CRAMPED_BELOW_PX = 1280` lives beside the
resolver rather than in the stylesheet, because JS owns both the width and the
`inert` attribute and a CSS-only fold leaves a hidden roster tabbable. The
es-419 door width was not re-measured — the fixture has no locale switcher, and
the English width still measures exactly the 244px the original derivation
recorded, so only the arithmetic changed. Internal naming, the two `data-*`
hooks on the preview band, and the `graph` / `graphSubtitle` catalogue strings.

**No repo-wide `rail` → `roster` rename**, deliberately: copy says roster, code
says rail, and a rename buried inside a behaviour change is unreviewable. The
storage key is the single exception, and it rotated for a behavioural reason.
