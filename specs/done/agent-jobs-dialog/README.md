# Agent jobs dialog — rationale record

SHIPPED 2026-08-06, starting at `934d1219`. (An earlier draft named a commit
range here; it went stale the moment this file was committed into it, which is
what a self-referential range always does. `git log --follow` on this folder is
the answer that stays true.) This is the durable *why*; the code is the *how*. [`choices.md`](choices.md) holds the
decisions made where the plan was silent, ranked least-confident first — read it
before changing any of them.

## What shipped

An agent's card no longer answers for what the drive is plugged into, and no
longer houses a panel of its work. **Integrations left the surface entirely.
Jobs left the card and became a door under the agent's name**, beside Train and
Settings, which opens a dialog holding every job that agent has — active and
finished — with the selected job's live conversation beside the list.

Entry points: `spa/routes/agents-map/agent-jobs/` (the dialog),
`spa/routes/agents-map/agent-surface/` (the surface it opens from),
`spa/routes/agents-map.tsx` (the only file that owns queries and navigation).

## Why it works this way

**A job *is* a session.** `onOpenJob` used to navigate to `/sessions/:id`
because a job's id already is a session id. That single fact is why the dialog
can show the real conversation rather than a drawing of one, and why the old
`JobDetail` — a hand-made summary of step, progress and question — stopped
having a reason to exist. Anything reintroducing a synthetic job view is
re-deriving a mistake.

**The dialog is the product's own, not the map's glass.** The map-glass option
was offered and rejected by the user; a measured finding later made that
compulsory anyway. The map's typography and its state colours are declared as
descendants of `.km-zoom` / `.knowledge-map`, and a dialog portals to
`document.body` — outside both — so a dialog wearing map classes renders
unstyled grey text. What it *does* borrow is the state vocabulary, through the
`.km-portal` seam, so a job that needs you is the same coral in the dialog as on
the agent's face out on the canvas.

**Nothing navigates.** Opening a job swaps a pane; it never leaves the map. That
is the same promise the zoom itself makes — the zoom is state, not a route —
which is why the dialog's open and selected state are React state rather than a
URL.

**The list is grouped because a flat one lies about its order.** Ten rows
reading 26 min / 51 min / 4 min / in 4 hrs / yesterday are sorted by a rule the
reader cannot see. An unprimed reviewer of the flat version called it arbitrary
and could not tell which row the pane beside it had called "Needs you".

## Invariants — what must stay true

**The two job views partition onto the display buckets, so the merge must not
sort.** A job is `active` exactly while its state machine is non-terminal and
not interrupted (`packages/backend/convex/domains/agentSessions/events.ts`), and
the map's `jobState` (`knowledge-map-data/project.ts`) collapses on the same
fact. Active rows can therefore only group as asking/running/scheduled and
history rows only as done. `groupJobs` is the entire ordering. A timestamp sort
in `job-feed.ts` would fight an answer the grouping already gives, every time a
finished job is newer than a running one. The no-sort half is genuinely pinned —
`job-feed.test.ts` shuffles timestamps against the requested order, so any sort
shows up as a different sequence.

**The partition itself rests on an unstated fact, and nothing enforces it.**
`groupJobs` has *five* buckets, not four: `fresh` ("Ready to read") exists and
would take history rows. It is unreachable only because `toMapJob` never sets
`job.fresh` — the only assignments in the repo are in tests. Start projecting
`fresh` and "history rows only as done" breaks silently, with every test green.
If that projection ever grows, the invariant needs a test before it does.

**The map's Escape listener stays on the bubble phase.** That is what lets
`leavesAgent` (`knowledge-map/keys.ts`) see that a layer above already handled
the key. Move it to capture — as the drive's document takeover does, for its own
reasons — and one Escape dismisses a dialog *and* flies the reader off the agent,
with the guard still present and still looking correct.

⚠️ **The phase is not test-enforced.** `keys.test.ts` pins `leavesAgent`'s
two-field logic and nothing else; no test anywhere drives a real Escape against
the map with a dialog over it. Adding `{ capture: true }` at that listener
reintroduces the bug with the whole suite green — which is exactly the failure
mode this paragraph exists to warn about. Treat the comment at the call site as
the only guard there is, and if you touch that effect, add the test.

**A shut dialog asks nothing.** `useAgentJobs` takes a nullable scope and
disables both queries rather than omitting the agent id — omitting it is a
*different filter* (the whole drive), not a pending state. Ungated, this fires
two paginated requests on every agent zoom for a panel nobody opened. Pinned by
`agent-jobs/use-agent-jobs.test.tsx`.

**Variables are shareable; a surface's geometry is not.** The block in
`knowledge-map.css` declaring the `--km-*` variables is shared with
`.km-portal`; the declarations giving the map its box are scoped to
`.knowledge-map` alone. Merging them back hands the dialog
`position: relative; width: 100%; height: 100%` and draws a full-width static
panel where a centred one belongs.

**`bare` returns the gutter to its host and keeps the measure.** A bare
conversation surface has no route header, so it must not keep the padding and
mask that let a thread scroll under one; and its composer keeps the thread's
`max-w-4xl` so the two stay one column at any width. Both rules live at the
scroller and footer in `routes/sessions.tsx` and apply to the agent's chat
column as well as to this dialog.

**Only two job states are ever saturated** — needs-you and running. Decorating
the resting case is how a map turns into a dashboard, and the heading above a row
is always the primary cue; the dot is a second one for the urgent two, never the
only one for any. Note the scope: that is a rule about the *list rows*
(`panes.tsx` gates them explicitly). The session pane's own header band draws a
dot for whatever state its job is in — which stays within the rule, because the
resting tones resolve to the muted greys and the band names the state in words
beside it.

**No counts anywhere.** The list paginates, so any number would be a floor
presented as a total.

## Where the build diverged from the plan

These are the things a future reader would otherwise re-derive.

**The stacking threshold was estimated at ~54rem and measured at 80rem.** The
estimate assumed the surface's left column stays at 46% of its width; the
`clamp()` actually takes its 33% middle at exactly the widths where a third door
is in question. Measured by sweeping the real fixture: the door row wraps at
1226px in es-419 and 1117px in English. **Spanish sets this number.** An estimate
carried from one slice into the next is not a measurement.

**The plan's own CSS seam was wrong and had to be split.** It said to add
`.km-portal` to the `.knowledge-map` selector list. That block ends with the
map's geometry, so doing so drew the dialog 1440×630 and statically positioned.
Caught by a probe before it shipped.

**The dialog grew to fill the window, mid-build, at the user's request.** It was
1024×640 with a `min(64rem, …)` ceiling; the ceiling was removed rather than
raised, because a ceiling is a bet that no screen is wider than the guess. Two
rem of canvas still shows on every side — that is what keeps it a thing *over*
the agent rather than a page that replaced it.

**The playground was drawing a lookalike conversation.** Every screenshot the
dialog had been judged on showed four hand-made bubbles and a fake composer. It
now mounts the production `SessionTimeline` and `ComposeBar`, and the real
product path measures pixel-identical to it. A fixture that approximates the
thing under review is not evidence.

**`onRetry` became required, and the read grew a refetch to make it so.** It was
optional while nothing in production could supply one — which made "Try again" a
button only the fixture could draw, and left the real failed dialog offering
nothing but a link off the map.

**The live staging journey was cut by the user.** `AGENTS.md` asks a change this
size to ship with one, run once as a closeout gate. It was put to the user
because that run provisions real VMs on a shared account where a leak steals CPU
from production workspaces. The closeout gate is the local sweep plus the in-app
probe. A deliberate deviation, not an omission.

## Dead ends

**Capping the whole session pane at `max-w-4xl`** to centre thread and composer
as one column. It opened a ~60px void down each side that read as a third
column, and made the pane a second owner of the thread's measure. The composer
keeps the measure instead; the pane keeps the gutter.

**Promoting the map's state colours to `:root`** so the dialog could read them.
The stylesheet's opening paragraph explicitly refuses this — it leaks a second,
competing palette into the product. Extending the selector list was the answer.

**Re-declaring the dialog's state colours against product tokens.** A third
vocabulary for one meaning, disagreeing with the map underneath.

**A `view: 'all'` on the wire.** `jobView` leads every job index, so it would
need a schema change and a backfill to save the client one request.

**Reusing `spa/jobs/job-row.tsx` for the dialog's rows.** It is a `<tr>` for an
`xl:`-gated table that links out to `/sessions/:id` — the one thing this dialog
exists not to do.

## A gate that does not catch this class of change

**A green `bun ui:check` is not evidence that nothing moved.** The screenshot
gate has `maxDiffPixelRatio: 0.005` and a per-pixel `threshold: 0.3`, and this
feature slipped past it three separate times:

- a change confined to the identity cluster is ~0.004 of the six-case
  `agent-surface` page (390×3769)
- the cutover's own action row is ~0.004 of a 1440×900 frame
- capping the composer moved its edges into *near-identical light pixels*, which
  the per-pixel tolerance swallows entirely

Each needed `bun ui:approve --force` and a look at the actual pixels. And
`--force` twice baked in drift belonging to neither the feature nor the fixture;
both were caught by pixel-diffing the result against `HEAD` and reverted. The
working rule: **keep a forced baseline only for a fixture that actually failed
the check, or that you have proved stale by looking at it.**

The geometry invariants are a second gate that `bun ui:check <id>` does not
reach — its filter matches fixture ids, and those tests are titled by surface.
Run them with `-g "overlaps anything else"`.

## Visual provenance

The two "before" images are the requirement: they are what the work was measured
against, and both show shipped defects the feature would otherwise have made
worse.

| image | what it is | what it drove |
|---|---|---|
| [`assets/before-mobile-identity-cluster.png`](assets/before-mobile-identity-cluster.png) | one case cropped out of the committed mobile baseline when the plan was written | The agent's name truncated to `Data .`, both doors clipped and running under the card. This is why the identity cluster restacks below the face at all, and why the threshold above exists. |
| [`assets/before-desktop-busy-chip-row.png`](assets/before-desktop-busy-chip-row.png) | the committed desktop baseline for a busy agent | Its chip row already scrolled the Integrations chip off-screen — which is why removing it cost a busy drive nothing visible. Jobs is visible in this frame, but only because it precedes Files in the row — a busier agent pushes it off the same way. Out of the strip, it cannot be pushed anywhere. |
| [`assets/shipped-desktop-dialog.png`](assets/shipped-desktop-dialog.png) | the result | Two panes, the real thread and the real compose bar, the grouped list with dots on only the two loud states. |
| [`assets/shipped-duet-row.png`](assets/shipped-duet-row.png) | the drive's own centre | Duet had never been captured by any fixture. Its action row was empty and hidden by CSS, so the Jobs door is the first thing that band has ever held. |

[`visualizations/roadmap.html`](visualizations/roadmap.html) is the plan as it
was pitched — before/after, the dialog's anatomy, and the measured findings that
overturned assumptions about this code. Kept because those findings are still
true and still surprising.

## Pointers

| concept | owner |
|---|---|
| the dialog frame | `agent-jobs/index.tsx#AgentJobsDialog` |
| the two panes, the list, the states | `agent-jobs/panes.tsx#AgentJobsPanes` |
| which job the right pane shows | `agent-jobs/showing.ts#jobsShowingOf` (pure) |
| two views as one list | `agent-jobs/job-feed.ts#mergeJobViews`, `#feedPhase` (pure) |
| the read, and the scope that gates it | `agent-jobs/use-agent-jobs.ts#useAgentJobs` |
| wire→map job projection | `knowledge-map-data/project.ts#toMapJob` |
| the buckets and their order | `routes/agents-map/job-groups.ts#groupJobs` |
| what Escape means on the map | `knowledge-map/keys.ts#leavesAgent` |
| the chip row's order | `agent-surface/header-order.ts` + `use-header-row.ts` |
| what the card draws | `agent-surface/stage.ts#stageOf` |
| queries, navigation, both session mounts | `routes/agents-map.tsx` |

Each invariant above names the test that pins it, or says plainly that nothing
does. The visual surfaces are the `agent-jobs-dialog` and `agent-surface-duet`
fixtures, driven from `tests/visual/playground.spec.ts`.
