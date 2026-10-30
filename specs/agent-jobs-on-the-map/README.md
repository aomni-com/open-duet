# Jobs on the map, and the dialog in the URL

An agent's recent work becomes **a seat in its own row** — Jobs, in the middle
of the apps, with up to five job nodes hanging off it and a sixth reading "more".
Clicking one opens the agent, with the jobs dialog from
[`agent-jobs-dialog`](../done/agent-jobs-dialog/README.md) on it — the seat on the
latest session, a bead on its own. **One click, and never at the ring level.** The
ring holds **twenty agents**, which before this it did not.

The seat is **organisational**: it says an agent has work and it opens the list,
and it carries no mark of its own. A **bead** says what its job is doing in its
fill and whether you have seen it with a ring around it. A **face** wears a dot
when that owner's own conversation has something unread. See decision 10.

**The picture is built, and the URL work is done elsewhere.** Slices 01–03 were
absorbed wholesale by [`url-map`](../done/url-map/README.md), which specified the
same grammar at drive scope and shipped it — the zoom, the dialog and the
selected job are all path now. Read that closed spec, not the slice files here,
which are superseded.

**The slice files are in [`slices/`](slices/); 06, 10 and 11 are what is left.**
Read
[`## Reversals`](#reversals) before [`## The nine decisions`](#the-nine-decisions):
decision 5 is reversed and F3 is superseded.

---

## Next Agent Prompt

**Status:** the picture shipped; the URL track shipped as
[`url-map`](../done/url-map/README.md). **04, 05, 06, 09, 10 and the bead's
unread ring are done; 07 and 08 are dropped.** Only **11**, the closeout, is
left. Last updated 2026-08-13.

**Everything in this spec has shipped except closeout.** What is left is
[11](slices/11-baselines-and-gates.md): `choices.md`, the two forward pointers
into [`unified-session-list`](../done/unified-session-list/README.md), and
archiving the whole feature with [close-spec](../../.agents/skills/close-spec/SKILL.md).

**Two things a fresh agent should know before touching this.** The staging
journey that covers this contract is `session-buckets` — its description ends
"a read clearing unread without moving the row", which is exactly what slice 05
fixed — and it runs against *live* staging, so it is a post-deploy check, not a
pre-merge one. And `@repo/gateway`'s "self-heal to the desired pin before
spawning" was already red on this branch's base; it fails in isolation and no
file under `packages/` is part of this feature.

**Read [`## Reversals`](#reversals) before [`## The nine decisions`](#the-nine-decisions).**
Decision 5 is reversed, F3 is superseded, and decision 10 is new. Then read
[`specs/done/agent-jobs-dialog/`](../done/agent-jobs-dialog/README.md) — its
README and its `choices.md`. This feature builds directly on it and **reverses one
of its invariants** (the closeout records that). Its invariants, dead ends and
gate traps all still apply here.

**Blockers / warnings**

- **The design changed twice during the build, and this README is the record of
  where it landed** — not the plan it started as. The dead ends are measured;
  they look like the obvious idea and none of them works.
- **Do not add a fifth seat to an agent's row.** `MIN_RADIUS` and
  `ARC_PER_SLOT` are both solved against four, and a fifth draws one agent's row
  through its neighbour's at 7, 10 and 12 agents.
- **The map draws no numbers at all.** Not a job count, not an unread count. The
  overflow node says **"more"**, never "+N" (decision 3); the Jobs seat carries
  nothing (decision 10); the only mark on the ring's unread axis is a dot on a
  face. F3, which used to be the reason for the first of those, is superseded —
  decision 3 now stands on its own reason.
- **The face's mark is the geometry risk, not the data.**
  `inkRadius(agent) = 34 × 1.16 = 39.4`; the dot straddles the plate edge at
  26 + 6 = 32. **F11 still stands — the ring has no caption-overlap gate at
  all** — so the only instrument is a shot. And see **F17**: full ink alone is
  invisible on a generated avatar, so the mark's rim is load-bearing, not
  decoration.
- **This feature cost 2N requests on the landing page (redeemed 2026-08-20 — see
  [`## Reversals`](#reversals))** for N drawn owners: one
  `…/sessions/default` and one `done` page each. `use-workspace-map.ts`'s own
  header is a monument to deleting exactly that, and
  [`unified-session-list`](../done/unified-session-list/README.md) records *"the
  fan-out is the server's"* as a decision. **This reverses it deliberately, as the
  price of the frontend-only constraint the user chose.** One line in
  `activity.ts` redeems it and deletes two client modules — see *Reversals*.
- **The dialog opens only within the agent view, never at the ring.** Settled
  with the user after a spec detour said otherwise — see *Reversals*. Slice 08 is
  dropped and `focusOf` is right as it stands.
- `bun ui:check <id>` does **not** reach the geometry invariants. Run them with
  `-g "overlaps anything else"`.
- **The crowded fixture used to ship `unread: false` everywhere**, so the mark
  had never been photographed at twenty agents — the only density where its
  legibility is in doubt. It now gives every third owner an unread chat. *(The
  baselines themselves do exist and pass; the older warning that
  `knowledge-map-jobs` had never been shot was stale — see
  [slice 04](slices/04-the-unread-axis.md).)*
- **A forced baseline can bake in drift that is not yours.** These fixtures carry
  ~0.5% whole-canvas drift against this machine's Docker image, just under the
  threshold — `knowledge-map-empty` moved by 6271px on a scene with no agents at
  all. **Trim the diff's bounding box to tell them apart**: a real change is
  localised, drift covers the whole frame. See F18.
- **Read gate exit codes, not gate output.** `bun run lint | tail` reports
  nothing useful and an empty `PIPESTATUS`; a genuine lint error read as a pass
  cost one whole Docker run here, which dies in pre-flight before Playwright
  takes a single shot.

**Global TODO**

- [x] The Jobs seat, its second row, the overflow mark, their state colour
- [x] The attention badge removed from the agent's face — the work is nodes now
- [x] Frame budget: the open-a-branch flight, measured and fixed (see below)
- [x] The flight home, which had never matched the flight in
- [x] Three finishes behind `data-look`, `laser` the default
- [x] The crowded tier — twenty agents at 49px faces instead of 33px
- [x] The job vocabulary moved down to `knowledge-map/job-groups.ts`
- [x] The seat is a door — `onOpen({kind:'jobs'})`, wired in `agents-map.tsx`
- [x] An interactive harness at `playground/knowledge-map-jobs`
- [x] 01–03 — the URL grammar, the zoom, the dialog → shipped as
      [`url-map`](../done/url-map/README.md)
- [x] **04** — `unread.ts` + `hasUnread(node)` + `Agent.chat` + `CoreNode.agent`
      + `UnreadDot` on the face and the core; the Jobs seat stripped of both its
      unread mark and its state roll-up. Shot, cropped and looked at.
- [x] **05** — reading a session clears it in `activity` and `default` too.
      `patchSessionAsideCaches` in `session-cache.ts`, called from both writers;
      `sessionKeys.defaults(ws)` added as the family prefix. Red watched first.
- [x] **06** — `use-default-chats.ts` reads the alias per drawn owner;
      `project.ts#splitChat` takes that record out of the work and onto the
      face. The face's dot is live on a real drive, and the phantom bead — a
      default chat drawn among the work that the dialog has no row for — is
      closed. Falsified against a no-op split.
- [x] **07** — **dropped.** There is no numeral for finished work to reach, so
      F13 (an owner with only finished unread has no seat) and F14 (a
      frontend-only count cannot be exact) both stopped being problems rather
      than being solved. See [07](slices/07-finished-work-reaches-the-numeral.md),
      kept as the record of why.
- [x] **08** — **dropped, unbuilt.** The dialog opens *within* the agent view,
      which is what the code already does; the `over` axis existed only for the
      ring-level dialog that is not wanted. `?branch=` is still retired, by 10.
- [x] **09** — one click opens the agent view with the dialog on it: the seat
      and the overflow on the **latest** session, a bead on its own. `latestJob`
      picks by recency, not reading order; the route writes it to the URL with
      `replace` so the URL stays the one owner of what is open.
- [x] Job beads carry unread as a ring around the bead, state as the fill.
- [x] **10** — deleted: `openBranch`, `openedElsewhere`, `Openable`/`node.open`,
      `JOB_OPEN_*`, `KnowledgeMapZoom.jobs`, `openId`, `nodeClass`'s `open`,
      `branchJob`, `MapPlace.branch`, `MapFocus.branch`, `?branch=`/`?session=`.
      `ctx.jobTitles` **kept** — it is solved from the resting arc and is now the
      only thing deciding bead captions.
- [ ] **11** — baselines, the unprimed critique, and closeout
- [ ] Closeout: amend the archived spec's "the zoom is state, not a route", write
      `choices.md`, and add the two forward pointers into
      [`unified-session-list`](../done/unified-session-list/README.md)

**Before you end your pass, update this section.**

---

## The two budgets — the fact the whole design turns on

The ring spends two independent things, and **neither has room left outward.**

**Arc** — circumference between neighbouring agents, spent by anything drawn
*sideways*. `MIN_RADIUS = 316` exists solely to hold neighbouring fans apart and
`layout.ts` says so. Measured cross-agent clearance with today's four-seat fan,
against the test's own 8-unit bar: **+24 at 7 agents, +10 from 8 up, +6 at 24 —
already touching.**

**Radius** — how far out the drawing reaches. The camera fits the union of every
node's box into the container's *short* axis, so radius is the axis the camera
pays for. And the ring's radius already grows linearly with the fleet, because
every agent claims a fixed slice of arc.

That second sentence is the whole problem. **The ring at rest, today, measured
with the real camera (`fitScale` over `framedBox`, worst of the three surfaces
`framing.test.ts` uses):**

| agents | 7 | 12 | 16 | **18** | **20** | 24 |
|---|---|---|---|---|---|---|
| camera | .802 | .689 | .566 | .520 | .481 | .417 |
| face | 54px | 47px | 38px | 35px | **33px** | 28px |
| smallest caption | 11 | 11 | 11 | **10.9** | **10.0** | **8.7** |

`TEXT_FLOOR` is 11 and `type-scale.test.ts` asserts it — but its fleet list stops
at **16**, which is exactly the last size where the promise still holds. The map
already knows: *"the reserve runs out … at around nineteen agents"*.

So **"a beautiful home at twenty agents" is a change to the ring, not a
consequence of drawing jobs on it** — and anything hung outward makes it worse.

### What the shipped shape costs, measured

The row does not grow, so the arc is untouched. What the second row spends is
**radius**, and the camera pays for that — which means the honest statement is
the uncomfortable one: **a drive with work in flight draws smaller than the same
drive at rest.** Measured with the real camera, worst of the three surfaces
`framing.test.ts` uses, faces in real pixels on a 1440×900 laptop:

| agents | 3 | 7 | 12 | 16 | 20 | 24 |
|---|---|---|---|---|---|---|
| camera, nobody working | .887 | .802 | .689 | .923 | .765 | .654 |
| camera, every agent working | .684 | .729 | .622 | .662 | .578 | .513 |
| face, working | 36px | 38px | 32px | 35px | **30px** | 27px |

An earlier draft of this plan claimed work in flight cost the camera nothing.
That was true of a design that hung the jobs *inside* the ring and is false of
this one; the claim is corrected rather than deleted because it is the kind of
thing a reader would otherwise assume still held.

The step up at 16 is the crowded tier arriving — the ring gets *bigger* as it
crosses, the same way it does today when the dense tier arrives at 8.

**The caption floor is where the drawing actually ends.** With every agent
working it holds to **22** and breaks at 24 (10.7px against an 11px floor).
`type-scale.test.ts` asserts the contract at 20 and pins the ceiling from both
sides, so a change that lowers it goes red there rather than on somebody's
twenty-three-agent drive.

**Why the second row is on the tangent and not the arc.** The map's tangent rule
(`knowledge-map/README.md` → *where a fan sits*) exists because captions on an
arc land on different baselines and read as misalignment. The second row carries
captions whenever it has the room for them, so the rule reaches it directly — it
is the same rule, one level down, not an exception to it.

## Reversals

Read this before the decisions below. Nothing here is erased from that list — a
reversal that deletes its predecessor destroys the reason, and this README's own
precedent is to correct rather than delete (see the camera-cost claim above:
*"the claim is corrected rather than deleted because it is the kind of thing a
reader would otherwise assume still held"*).

**The 2N client fan-out is un-reversed — the wire answers the pointer.**
2026-08-20. The paragraph below headed *"Do not 'fix' this back without reading
this paragraph"* asked for exactly this and named its price: *"the redemption is
one line in `activity.ts` … when it lands, `use-default-chats.ts` … is deleted."*
It landed. `AgentActivitySchema` gained `chat`, resolved from the owner's pointer
by id and lifted out of `sessions` before the seats, `truncated` and the
between-owner recency are measured; `use-default-chats.ts`, the per-face backstop
timer and the fingerprint watch that spent that fan-out sparingly are all gone,
and `splitChat` no longer filters — the wire owns the split.

What forced it was not the request count. The gap between the two answers was
visible: the alias fan-out could not start until the roster resolved while the
activity read fired at once, so on every cold load each owner's chat was still
among its work — a Jobs seat and a bead for a conversation the dialog behind
them withholds, and the seat displaced an app tile. An owner whose alias read
failed never healed at all.

`use-finished-jobs.ts` is *not* part of this: the activity read had already
grown the `done` bucket, and that module was gone before this.

**Decision 5 is reversed — one click opens the dialog.** 2026-08-13, with the
user. What killed the two-step was not the drawing but the arithmetic: it cost a
click on every route to the only thing the branch leads to, and the second step's
payoff — five titles at reading pitch — is what the dialog already does better,
with all four buckets and a conversation beside it. The intermediate state was
never a destination. The flight was real, measured and fast (45 frames, 546–559ms
each way, p95 9.3ms); speed was never what was wrong with it.

**The dialog still unfolds the agent — a mid-flight reversal that was itself
reversed.** For part of 2026-08-13 this spec said the dialog must open *over the
ring*, without unfolding the agent, and [slice
08](slices/08-what-the-dialog-stands-over.md) was written to make that possible
(a `MapPlace.sessions.over` axis, because the dialog is a child of the agent
surface and cannot exist without it).

**That is not what the product wants.** Settled: *"we never open the dialog at
the tree level. We only open it within the agent level."* Clicking the Jobs seat
**opens the agent view** and puts the dialog on it. Clicking a bead does the same,
focused on that job. Which is what the code already did — so slice 08 is
**dropped, unbuilt**, and `focusOf`'s existing behaviour and doc comment are
correct as they stand.

What survives from that detour and still ships: **one click, not two** (slice 09),
and the deletion of the branch fly-in behind it (slice 10).

**The unread numeral was built, shot, and replaced by a dot.** 2026-08-13. The
first cut of this feature put a *count* on the Jobs seat and on the face, under a
rule that every number on the map is an unread amount. Two things killed it. The
face's number could only ever read `1` — an owner has one default chat — so it
was a dot paying for a digit. And the seat's number was a summary of a list drawn
where there is no room to name what it summarises, which is the same objection
that took the roll-up badge off the face in the first place. **The seat now
carries nothing at all**, including the state badge it used to wear: it is a
door, and the dialog behind it answers both questions per row. Job-level unread
left the map with it, deliberately.

What survived from that cut and is worth keeping: the `--km-bg` rim on the mark
(F17), and the finding that the visual gate cannot see a change this small
(F16).

**The map's fan-out moves back to the browser.**
[`unified-session-list`](../done/unified-session-list/README.md) records *"the
fan-out is the server's — `owners × 3` index reads is the same work against the
same index either way; doing it here costs one request instead of one per face."*
This feature reverses that: one `…/sessions/default` and one `done` page per drawn
owner, 2N requests on the landing page. **The reason is not that the argument got
worse — it is still right — but that the user chose to ship this without a
backend change.** The redemption is one line in `activity.ts` (read all four
buckets, and return each owner's default-session id and its unread); when it
lands, `use-default-chats.ts` and `use-finished-jobs.ts` are deleted and
`project.ts`, `layout.ts` and `map-node.tsx` are untouched. **Do not "fix" this
back without reading this paragraph** — the client-side fan-out is a decision,
not an oversight. *(Superseded 2026-08-20: the redemption landed. See the first
entry under [`## Reversals`](#reversals) — the paragraph is kept because the
reasoning is what makes the reversal legible.)*

**Completed work now fills the empty job seats.** 2026-08-17, with the user.
The Jobs section used to disappear as soon as its last session completed. The
workspace activity read now returns all four buckets in priority order:
`asking`, `running`, `scheduled`, then `done`. The ring still seats only five;
unfinished work therefore cannot be displaced, and the newest completed rows
fill whatever space remains. A terminal cache patch keeps the row in that same
summary, so completion no longer causes a disappear-then-reappear flicker.

This also supersedes the `done`-page half of the browser fan-out above: default
chat aliases remain per owner, but completed map rows come through the existing
server-side activity fan-out rather than through `use-finished-jobs.ts`.

A fresh visual review at twenty agents found those completed beads deliberately
quiet enough to resemble background marks at first glance. That is accepted:
`done` is retained context, not an alert, and strengthening it would make normal
history compete with the asking and running tones. The Jobs seat and its branch
preserve discoverability; state colour preserves the priority the limit uses.

## The nine decisions

Settled with the user, except where marked. **Fixed — do not re-open** *except
where `## Reversals` above says otherwise.*

1. **Jobs is a seat in the agent's own row**, in the middle of the apps, with
   the jobs hanging off it in a second row below. It **takes** a seat rather than
   adding one — an agent with recent work shows one app fewer — because the
   row is four wide at every fleet size and both the ring's radius floor and its
   arc per slot are solved against that.
2. **Up to five job nodes, then one more mark** — the `MAX_APPS`/`MoreNode`
   rule with its own maximum. Unfinished rows take the seats first in
   `asking` → `running` → `scheduled` order; newest `done` rows fill the
   remainder. A sixth recent job draws five nodes and one overflow.
3. **The overflow says "more", with no number.** ~~(F3.)~~ Not because a count
   would be a floor — F3 is superseded — but because the mark stands for the rows
   the *row* could not hold, and a number in that corner would compete with the
   unread numeral in the other. One numeral on this map, one meaning (decision
   10).
4. **The overflow opens the dialog with no job selected** — it means the list.
5. ~~**The first click comes closer, the second opens.**~~ **Reversed
   2026-08-13 — see [`## Reversals`](#reversals).** One click opens the dialog:
   the Jobs seat with no job selected, a bead on that job, neither unfolding the
   agent behind it. The camera flight, `openBranch` and `node.open` are deleted
   rather than left unreachable ([slice 10](slices/10-delete-the-two-step.md)).
   The original text is kept because a reader who knows this spec would otherwise
   assume it still holds.
6. **The URL carries the zoom and the job**, nested:
   `agents` → `agents/:agentSlug` → `…/jobs` → `…/jobs/:jobId`.
7. **The agent detail canvas moves to `computer/agents/:agentSlug`**, beside the
   drive's other configuration surfaces. That is what frees `agents/:agentSlug`.
8. **Hard cutover — no redirects.** Chosen explicitly after being told a stale
   link would break.
9. **Twenty agents is the tested contract.** `layout.test.ts`, `framing.test.ts`
   and `type-scale.test.ts` all grow a 20-agent case, and the ring is changed
   until they pass. 24 is measured and recorded as the headroom.

10. **One mark, on a face, for that owner's own conversation. The Jobs seat is
    organisational and carries nothing.** Settled with the user 2026-08-13,
    after a numeral version was built and rejected — see *Reversals*.
    `knowledge-map/unread.ts#hasUnread` is the rule, a function of the node
    alone, so no surface can hold a second opinion.

    A **dot, not a numeral**: an owner has exactly one default chat, so the only
    honest count is one, and a number that can only ever read `1` invites the
    reader to look for a second digit.

    The seat carries **neither** an unread mark **nor** a state roll-up. Both
    were summaries of a list, drawn in the one place with no room to say which
    row they were summarising; the dialog the seat opens holds that list
    properly, per row, with a title beside each. What still speaks for the work
    on the ring is the beads — one node per job, each with its own state as
    tone, which is the map's own idiom of rows rather than counts.

    **Job-level unread is on the beads, not on the seat.** A bead's *fill* is
    what the job is doing; a **ring around it** is whether you have seen it. Two
    axes, two channels, on the one node that can carry both — and it has to be a
    ring rather than a second dot, because a bead is ~5px of ink at twenty
    agents and anything hung beside it is sub-pixel and lands on its neighbour.

    The ring is the **same full ink as the agent's dot**. The two marks agree by
    *material* rather than by hue, which is the only way to agree without
    spending a third saturated colour on a map that budgets two — and the bead's
    hue is already spoken for by its state.

Plus: ~~**the whole branch is put away when you zoom into that agent**~~ and
~~**only one branch is open at a time**~~ — both were properties of the branch
fly-in, which decision 5's reversal deletes.

---

## Verified findings

Measured during planning against the real code. Re-verify before contradicting.

| | finding | evidence |
|---|---|---|
| **F1** | **The ring breaks its own text floor at 18 agents today**, with no jobs branch and nothing changed. `type-scale.test.ts`'s fleet list stops at 16 — one short of where it would go red. | `fitScale` over `framedBox`, three surfaces |
| **F2** | **A radial stack outside the fan is unaffordable.** Five nodes strung beyond a hub past the fan puts 20 agents at 7.3px text and breaks the floor at **five** agents. No choice of lift, pitch or disc closes a 366-unit radial reach. One row at a fixed lift is affordable; a stack is not. | sweep, table under Dead ends |
| **F3** | ~~**The map's job read is drive-wide and capped.**~~ **Superseded** by [`unified-session-list`](../done/unified-session-list/README.md): the read became **per owner** (`listSessionActivity`, bounded by `limitPerAgent`, default 24), `useJobList(view:'active')` no longer exists, and the Jobs seat's unread numeral already ships on that basis. A per-agent count is now supportable — which is what decision 10 rests on. **What survives:** decision 3, on its own reason (see it), and a *new* and different cap — the `done` page — which is why the finished-work numeral is not exact (F14). | re-read at source, 2026-08-13 |
| **F12** | **Marking a session read never reached the map.** `sessionKeys.activity` and `sessionKeys.default` sit outside `sessionKeys.lists()` by design (`query-keys.ts:120-122`), and `session-cache.ts` patches only `detail` and `lists`. So the Jobs seat numeral has been **sticky-until-window-focus since it shipped** — a live defect nobody had named, invisible to types and to the visual gate. [Slice 05](slices/05-reading-clears-the-numeral.md) fixes it, and the face numeral cannot ship before it: that one is cleared by clicking the very node it sits on. | read at source |
| **F13** | ~~**An owner whose only unread work is finished draws no Jobs seat at all.**~~ **Superseded 2026-08-17:** the activity summary now carries completed rows and `seatedJobs` retains them after every unfinished row, so an owner with only finished work keeps the Jobs seat and its newest completed beads. | read at source; superseded by the retained-history change |
| **F14** | **A frontend-only finished-work count cannot be exact.** `useSessionList` pages at 30; the activity read is bounded at `SESSION_ACTIVITY_DEFAULT_LIMIT = 24` per owner. Two reads, two bounds. Accepted with the user: the numeral counts all in-flight unread plus the newest page of finished, understating rather than overstating, and `9+` absorbs nearly every case. | read at source |
| **F18** | **These baselines carry ~0.5% whole-canvas drift against this machine's Docker image.** Measured with `magick compare -metric AE`: every map fixture differs from its committed baseline across the *entire* canvas, `knowledge-map-empty` by 6271px (0.484%) — and that scene is Duet alone, no agents, no apps, no jobs, so **no change to this feature could possibly have touched it.** It sits just under `maxDiffPixelRatio: 0.005`, which is why `ui:check` passes and `--force` silently bakes it in. **How to tell drift from a change:** trim the diff's bounding box. A real change is localised; drift covers the whole frame. Revert any forced baseline whose diff is whole-frame and whose fixture cannot have changed. | measured 2026-08-13 |
| **F19** | **Every mark on this map needs its own separation, because nothing controls what it sits on.** Three times in one feature: full ink vanished on a generated avatar (F17); an amber ring blurred into a rust *asking* bead, the one pair closest on the wheel and the most urgent thing the ring draws; and the focused face was washed by the zoom scrim, which was `inset: 0` over a canvas whose whole point is the hole in it. Each was invisible to every gate and found only by cropping a shot. **The rule that came out of it:** a mark carries a rim or a gap in the page's own ground, and does not assume its background. The scrim's hole is cut from `--km-hole-*`, published by the measurement the camera already takes of the well, so it tracks at any window shape rather than being a percentage guessed against one laptop. | measured 2026-08-13 |
| **F18b** | **Unread is amber, and that is a third saturated colour on a map that budgets two.** Spent deliberately: the two it had are *states* — `--km-ask` rust, `--km-live` blue — so both colours a reader would instinctively read as "new" were taken, and full ink read as a smudge rather than as something waiting. Amber is the one hue this map deliberately vacated (running moved off it; the stylesheet header records why), so it steals meaning from nothing. | 2026-08-13, with the user |
| **F17** | **Full ink is not legible on a face.** `.km-unread-bg` fills with `--km-fg`, which reads perfectly on the Jobs seat because that plate is a known pale tile. An agent's plate is a **generated avatar in an arbitrary colour**, and on a dark one the disc vanished into it completely — all that survived was the light glyph, and for a count of one that is a thin vertical stroke reading as a scratch on somebody's portrait. Found by cropping the shot and looking; the gate passed it, and no test could have caught it. The mark now carries a `--km-bg` rim so it separates from any ground, and the face's inset straddles the plate edge (26 of 34) instead of sitting inside it. **The `unified-session-list` objection was righter than the re-opening argument allowed**: the "which job" half dissolved, but "a mark on a portrait" had a second failure mode nobody had named. | measured 2026-08-13 |
| **F16** | **The sub-threshold trap has a measured instance now.** Adding the face numeral lights **7 faces at 20 agents** (probed: `unreadOf` over the fixture's own scene) and `bun ui:check` across all four map fixtures still reported **19 passed, zero baselines moved**. A numeral disc is a few hundred pixels; seven of them sit inside `maxDiffPixelRatio: 0.005` on a 1440×900 canvas. **A green `ui:check` is not evidence that a visual change is absent** — it is evidence that it was small. Force the baseline and look. | measured 2026-08-13 |
| **F15** | **The crowded fixture ships `unread: false` in all four places.** The base fixture has one unread job (`knowledge-map-fixture.ts:96`), so the mark itself has been shot — but never at twenty agents, which is the only density where its legibility is in doubt. | read at source |
| **F4** | **A *fifth* seat in the row collides.** −7 at 7 agents, +7 at 10, −20 at 12, against an 8-unit bar. Raising `ARC_PER_SLOT` to compensate then fails `type-scale.test.ts`. Four seats is why Jobs takes one instead of adding one. | `layout.test.ts`, run against a five-seat row |
| **F5** | **`zoom` holds a click-time snapshot.** `hit` passes `node.data` and `setZoom` stores it, so `focus = zoom.agent` never updates afterwards. Making the URL the owner turns it into a live projection — a behaviour change, not a refactor. | `knowledge-map.tsx`, `agents-map.tsx` |
| **F6** | **`SessionsRouting.session` returns `/agents`.** `sessions.tsx:517` navigates to it when the first message creates a thread. Harmless while the zoom is state; once the zoom is the path, **it throws the reader out to the ring on their first message.** | `agents-map.tsx:168`, `sessions.tsx:517` |
| **F7** | **Four modules hand-roll "which paths are the map"** — `PRODUCT_DESTINATIONS`, `driveCanvasPattern`, `drivePathPatterns`, `loadingViewForPath`. Each must learn the new shapes or the canvas renders as a document, the tab goes dark, or the loading frame is wrong. | `drive-routes.ts`, `loading-route.ts` |
| **F8** | **Four pure helpers assume one level.** `carriedBy` and `familyIds` test `node.parent === agentId`; `edgeClass` hides a limb on `link.from === focus`; `nodeClass` restores captions on `node.parent === hover`. **Every one is false for a grandchild.** | `layout.ts`, `knowledge-map.tsx` |
| **F9** | **`PRODUCT_DESTINATIONS` is matched first-to-last.** Giving `agentsMap` a `:agentSlug` pattern while it sits above `marketplace` retitles `/agents/marketplace`. `route-metadata.test.ts:39` is the tripwire. React Router itself ranks by specificity and does not care. | `product-destinations.ts` |
| **F10** | **The ring's `type-scale`/`framing` fixtures passed `jobs: []` and stopped at 16 agents.** They would have sailed past this whole change without measuring any of it — the twenty-agent claim was made while nothing tested past sixteen. Both now carry work in flight and run to 20. | those two test files |
| **F11** | **The ring has no caption-overlap gate at all.** The Playwright `overlaps anything else` check covers the two agent-surface fixtures only; the bun test measures `discRadius`, which excludes labels by design. | `playground.spec.ts` |

---

## One owner per concept

| concept | owner after | what this deletes |
|---|---|---|
| the map's URL grammar | **new** `drive/agents-map-url.ts` (pure) | three regexes and one segment-walk in four modules (F7) |
| a URL place → what is unfolded | **new** `routes/agents-map/where.ts#focusOf` (pure) | `idOf`, `onZoom`'s reset branch |
| the zoom | the URL | `useState` in `agents-map.tsx` |
| the dialog's open + selected job | the URL | `jobsOpen`, `picked` |
| how crowded the ring is | `layout.ts#ring`, as one `Ring` record | the `dense` boolean, read as a proxy for four different things |
| the node tree and its ids | `layout.ts` | — |
| what is put away when zoomed | `layout.ts#carriedBy`, reading each node's **owner** not its parent | `edgeClass`'s `link.from === focus` (F8) |
| a job's state and its tone | `knowledge-map/job-groups.ts` (moved **down** from `routes/`) | the second tone table the ring would need |
| what a node's box is | `metrics.ts#size` / `discRadius` / `inkRadius` | — |
| the job read | `agent-jobs/use-agent-jobs.ts` — scope now from the URL | — |
| **the unread mark, and which node wears it** | **new** `knowledge-map/unread.ts#hasUnread(node)` | `unreadCount` and `UNREAD_MAX_SHOWN` (deleted outright — no count survives), and `palette.ts`'s claim on an axis its own header says is not a tone |
| **what the mark is drawn as** | **new** `map-glyphs.tsx#UnreadDot` | the inline `<g className="km-unread">` in `JobsBody`, and the copy the face would need |
| **what the Jobs seat says** | nothing — it is a door | the seat's unread mark *and* its `attention` roll-up (`Badge`); `attention()` itself survives for the rail and the surface's door |
| **which session is an owner's own chat** | the wire — `AgentActivitySchema.chat`, resolved from the owner's pointer (was `knowledge-map-data/use-default-chats.ts`, deleted 2026-08-20; see [`## Reversals`](#reversals)) | nothing today — it has **zero** owners on the client — and it forecloses the two wrong ones: picking it out of a session list, and reading the feed's copy of the row |
| the default chat as a map record | `project.ts#toMapAgent`/`#toDuet`, from `AgentSlice.chat` **only** | the phantom bead, and the chat's share of the seat's numeral |
| the five-seat recent-work summary | backend `sessionActivity` → `job-groups.ts#seatedJobs` | the separate `use-finished-jobs.ts` plan and the completed-session disappearance |
| **what a click on a node means** | **new** `knowledge-map/hit.ts#intentOf(node)` | the `openId` branches in `hit()` — and with them the two-step, enforced by a signature that cannot express it |
| **is the dialog open, whose, and over what** | `where.ts#viewOf` → `MapView.jobs` | `jobsOpen`, `picked`, `jobsAbout`'s derivation from `focus`, and `agentScope`'s double duty |
| **what the dialog stands over** | `MapPlace.sessions.over` | `MapPlace.branch`, `?branch=`, `MapFocus.branch` |
| the branch fly-in | **nobody — deleted** | `openBranch`, `openedElsewhere`, `Openable`/`node.open`, `JobsNode.deg`/`along`, `KnowledgeMapZoom.jobs`, `openId`, `JOB_OPEN_*` |

**No transitional seams.** Every deletion is unconditional. Slices 01 and 06 are
pure moves whose proof is that their existing tests pass unedited.

---

## Firewalls — out of scope

- The dialog's own interior — it shipped, and decision 5 says this feature
  reuses it untouched.
- The legacy `agents/:agentSlug/train` redirect.
- Making the ring elliptical to spend the container's unused width. It is the
  one idea that would buy real headroom past twenty-three agents — the camera is
  short-axis bound and a 1440×900 window leaves ~1.9× of the long axis unused —
  and it needs `build()` to know the viewport, which `layout.ts` deliberately
  does not. This is the next thing to try if the ceiling ever has to move.

---

## Standing verification gates

Every slice producing a visual shot runs an unprimed
[`screenshot-critique`](../../.agents/skills/screenshot-critique/SKILL.md) as its
last check, and
[`compare-screenshots`](../../.agents/skills/compare-screenshots/SKILL.md)
wherever a prior look changes — the ring's baselines all have one.

Human checkpoints are **non-blocking**: open shots with
[`preview-shots`](../../.agents/skills/preview-shots/SKILL.md), give ~5 minutes,
then decide on the evidence, record it, close the shots and continue.

```bash
bun test apps/web/spa/knowledge-map               # the pure geometry
bun test -g "overlaps anything else"              # NOT reached by ui:check <id>
bun --cwd=apps/web run test                       # + boundaries + coverage
bun --cwd=apps/web run check-types
bun --cwd=apps/web run lint
bun --cwd=apps/web run visual:coverage:write      # any new .tsx symbol, tests included
bun visual:union:write && bun visual:union
bun assets:verify
bun ui:check knowledge-map-jobs      # no baseline yet — this is owed
```

> ⚠️ **Three gate traps, all documented in the archived spec and all live here.**
> A real change can pass `ui:check` **sub-threshold** (`maxDiffPixelRatio: 0.005`,
> per-pixel `threshold: 0.3`) — six small beads on one agent of a three-agent ring
> is well inside that budget. `--force` has twice baked in drift belonging to
> neither the feature nor the fixture. And a green tick is not evidence: **diff
> the pixels and look.** Keep a forced baseline only for a fixture that actually
> failed, or that you proved stale by looking at it.

---

## Re-opened, deliberately

**The unread badge on the agent's face.**
[`unified-session-list`](../done/unified-session-list/README.md) rejected it:
*"past seven agents a coloured dot on a portrait has no room to say which job it
is about."* That objection was about a **roll-up** — a mark standing for N jobs,
on the one surface with no room to name which. The mark that goes back is not a
roll-up: it stands for exactly one conversation, the one the face's own click
opens, so there is nothing to disambiguate and the "which one" question cannot
arise. It is also a **full-ink numeral, not a coloured dot**, so it reuses that
spec's *next* dead end rather than reopening it — no tone is spent and it does not
compete with the two saturated states.

**What survives of the objection is room, not meaning.** At twenty agents the
face is 33px and the caption floor has no reserve. That half is real, and it is
answered by `type-scale.test.ts`, the overlap gate and an unprimed critique — not
by argument. See [slice 04](slices/04-the-unread-axis.md).

## Dead ends — already measured, do not repeat

**The two-step onto a branch.** Recorded here rather than deleted with its code.
Built, measured and shipped: a first click flew the camera onto the jobs spoke and
let the row lay itself out with titles, a second opened the dialog. It cost a
click on every route to the only thing the branch leads to, and the intermediate
state was never a destination — nothing lived there the dialog does not hold
better. **Speed was never what was wrong with it** (45 frames, 546–559ms each way,
p95 9.3ms). Of the three frame-budget fixes it paid for, two are general and
survive; only `openBranch`'s reference-preserving rebuild went with it.


**A radial stack hung outside the app fan.** The first design, and the one that
looks obviously right: a Jobs node past the fan with five jobs strung beyond it.
It reaches 366 units past a radius that already grows with the head count, and
the camera pays for both. Measured smallest caption against an 11px floor:

| agents | 3 | 5 | 12 | 16 | 20 | 22 |
|---|---|---|---|---|---|---|
| smallest caption | 11 | **10.8** | **9.5** | **8.3** | **7.3** | **7.1**, clipped |

It breaks the floor at *five* agents. Shrinking the nodes and tightening the
pitch moves the failure by two or three fleet sizes and no further. **Any variant
of "stack them outward from a node past the fan" is this row.** The shipped
second row is affordable because it is *one* row at a fixed lift, not a stack.

**Beads strung inward along the trunk, between the agent and the drive.** It
costs the camera nothing, which is why it was built — and it was rejected on
sight, by the user, in one sentence: the dots read as debris standing in front of
the agents rather than as anything belonging to them. Worth recording precisely
because the measurement was excellent and the answer was still wrong: the
interior of the ring is empty for a reason, and filling it reads as clutter in
the middle of the picture no matter how cheap it is.

**A fifth seat in the row.** −7 at 7 agents, +7 at 10, −20 at 12, against an
8-unit bar. `MIN_RADIUS` and `ARC_PER_SLOT` are both solved against four seats,
and buying the arc back then fails the type floor. This is why Jobs *takes* a
seat instead of adding one.

**Keeping the fans and only tightening the arc past 16 agents.** The arc exists
to hold neighbouring *fans* apart; at `ARC_PER_SLOT = 150` two of them overlap by
1.4 units before their discs are counted. Tightening the arc and dropping the fan
are one decision, which is why `Ring.crowded` carries both.

**Laying an opened branch out as a vertical list.** It reads beautifully and it
is the wrong drawing: a job on this map is a node with a line to its owner, and a
list is what the dialog is for. Rejected by the user on sight, and correctly.

## What the frame budget cost, and where it went

Measured in a real Chromium with the harness's own determinism CSS stripped —
`PlaygroundShell` pins every transition to `0.001ms`, which is *non-zero*, so
every element fires the whole `transitionrun`/`start`/`end` triple on any style
change. That alone was 17,316 events per click and 90% of them were
`scrollbar-color`. **Nothing measured inside the playground is trustworthy
until that style element is removed.**

Opening a jobs branch at 20 agents, before and after:

| | fps | p95 | worst | frames >33ms |
|---|---|---|---|---|
| before | 100 | 30.3ms | 42.4ms | 8 |
| after | 115 | 9.3ms | 33.8ms | 1 |

Three fixes, in order of payoff:

1. **The SVG `transform` attribute → the CSS `transform` property.** The
   attribute goes through SVG's own layout path and re-rasterises the subtree;
   the property is the one browsers composite. `use-map-motion.ts` now has two
   writers and says why.
2. **`--km-hold` quantised to 0.05.** It drives caption `font-size`, a layout
   property, so a fresh value per frame was a full style recalc plus a text
   re-measure, 155 times a flight.
3. **Opening a branch stopped rebuilding the scene.** `build(data, open)`
   discarded every node object — **0% identity across the toggle**, so all 162
   memoised views re-rendered for an interaction that moves six dots. `build`
   depends on the data alone now and `openBranch` returns everything it does not
   touch by reference: **88%**.

**Measured and ruled out:** the core field. It draws 230 points batched into six
paths, and removing it entirely leaves idle at 120fps either way. There is no
Three.js on this map — `three` is imported by `app/sign-in/dotted-surface.tsx`
and nowhere else.

**`background-position` is not composited.** The laser grid drifted with it in a
first pass and measured 44fps with 78 janky frames in two seconds. It moves by
`transform` now, on its own element, which is why the grid and the glow are
`::after` and `::before` rather than one box.

## The flight, and why it never matched itself

Sampling the camera's scale every frame: going in took 45 frames and 555ms,
coming out took **one frame and 50ms**. Two effects were racing — the resize
re-solver listed `focusId` in its dependencies, so leaving a zoom ran
`reframe(false)` in the same commit, and `false` means *arrive*. It cut the
camera to the destination on frame one and the flight was dead before it
rendered. It re-solves for a view change and nothing else now: 50 frames each
way, 546–559ms.

This was never specific to jobs — the same effect governs the agent zoom, which
had snapped on exit since the effect was written.

## Known unknowns

- **Does a numeral on a portrait read as "1 unread message" or as "1 job"?** The
  governing rule makes every numeral mean one thing; whether a reader *infers*
  that rule from one glance is taste, and the unprimed critique in
  [slice 11](slices/11-baselines-and-gates.md) is the only instrument for it.
- **The core has no Jobs seat** (`layout.ts:437-446`, a deliberate omission), so
  the drive root's unread *jobs* stay unrepresentable on the ring while its chat
  now carries a numeral. Accepted and recorded; giving it a seat is barred by
  decision 1 and F4.
- **A bead is now a destination, not a zoom.** ~5px of ink with a 15-unit hit
  radius at twenty agents, and a mis-tap opens the wrong conversation rather than
  coming closer. The named retreat is in
  [slice 09](slices/09-one-click-opens-it.md).
- **The chat-exclusion flicker**: while the alias read is in flight, a default
  chat sitting in an unfinished bucket is still drawn as a bead. Rare and
  self-correcting; the alternative is withholding every bead on the ring until N
  reads answer.
- **Whether an unread default chat is common enough to justify the mark.** Nobody
  has measured how often the alias comes back `unread: true`.

- **Nothing here has a screenshot baseline.** `bun ui:check knowledge-map-jobs`
  has never run, and `knowledge-map`, `knowledge-map-home` and
  `knowledge-map-zoom` all move because the row changed. Until that is done the
  only evidence for the picture is the harness and the geometry tests.
- **Does a 20-agent ring read as a drive or as a thicket?** The geometry is
  proven and the taste is not. It has been looked at in the harness and it holds
  up; it has not had an unprimed
  [`screenshot-critique`](../../.agents/skills/screenshot-critique/SKILL.md),
  which is the standing gate for exactly this question.
- **Touch targets.** A job node is ~5px of ink at 20 agents on a laptop, with a
  15-unit hit radius around it. `M.BEAD_HIT` is a separate number from
  `M.BEAD_R` precisely so this can be tuned without moving the drawing, but no
  arrangement gets a 44px target at that pitch. The Jobs seat beside it is full
  size and opens the same branch, and every node is keyboard-reachable.
- **The production route's job door has only been read, not driven.** The
  playground exercises the whole chain; `agents-map.tsx`'s four state writes
  typecheck and are reviewed, but no test or live click has run them.
- **The harness cannot exercise the agent zoom.** It passes no children to
  `KnowledgeMapHome`, so no surface unfolds, there is no hole to aim at, and the
  framing effect returns early. The jobs zoom is measured in both directions;
  the agent zoom's fix is covered by the shared code path, not by a measurement.
- **The looks have been seen, not judged.** `laser` and `aurora` have shots in
  `assets/` and cost nothing measurable, but neither has had an unprimed
  [`screenshot-critique`](../../.agents/skills/screenshot-critique/SKILL.md).
