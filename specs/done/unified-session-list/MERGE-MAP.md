# Quadrant map — what the staging merges changed

> **Historical.** The second walk, kept for its reasoning. Superseded by
> [`README.md`](./README.md) for what actually shipped.

A second walk, run after `origin/staging` landed twice under this spec and moved
surfaces the ladder had planned against. [`MAP.md`](./MAP.md) still holds the 21
decisions from the first walk; nothing here re-opens one. This records only what
the merges invalidated and what the user decided in their place.

Decisions are numbered `M1…` so they cannot be confused with the map's `D1…`.

---

## Quadrant 1 — Known knowns

**Built and green at `723b8651`:** backend 940/940, web 1137/1137, contract
443/443, lint and typecheck clean outside `test-harness` (slice 11 owns it).
Slices 00–05 landed.

**The ring draws one node per session, machine or not.** Verified end to end and
worth stating because it is the premise of everything below:

```
use-workspace-map.ts:109/114   listSessions bucket:'running' + bucket:'asking'
            :160-169           grouped by owning agent — no filtering
project.ts:304                 slice.jobs.map(toMapJob)
            :170               `machine` read only for step/progress/wakesIn
layout.ts:344/486              activeJobs(agent.jobs), sliced to MAX_JOBS = 5
```

No machine test anywhere in that chain. A plain conversation sitting in `asking`
earns a seat exactly as a state machine does — which is slice 03's merge working
as designed, one zoom level further out than it was written for.

---

## Quadrant 2 — Known unknowns, resolved

### M1 — The ring fetches per-agent rows, not counts

Slice 09 planned to replace `Agent.jobs` with `Agent.activity` counts. **That is
now impossible**: staging draws one node per job (`layout.ts:344`), so counts
would delete the data the ring is made of.

The ring fetches per-agent rows across every unfinished bucket, capped. Cost is
N+2 requests. The three-request budget in `use-workspace-map.ts`'s header is no
longer true and its comment must stop claiming it.

*Why not the alternatives:* one workspace-wide paged list keeps the budget but
scales with the drive rather than the fleet; counts-plus-hover keeps two query
families in step for one surface's benefit.

### M2 — The five seats fill by urgency, not arrival

`layout.ts:486` takes `live.slice(0, MAX_JOBS)` in arrival order, and arrival
order is `use-workspace-map.ts:120`: the whole `running` page, then the whole
`asking` page. **An agent with five running jobs therefore draws zero asking
nodes** — the one thing that cannot proceed without a person is the one pushed
into "+N more".

Seats now fill `asking → running → scheduled`, then `updatedAt`. **Built** —
`activeJobs` sorts on `JOB_GROUP_ORDER` rather than carrying a second list, and
relies on `Array.prototype.sort` being stable by specification so the wire's own
recency order survives inside each bucket.

*This does not reverse slice 05.* The **badge** still ranks `running` above
`asking` (D13: money being spent outranks a question that waits, and the question
is still there when you click in). That argument is about one mark rolling up
many jobs. **Which jobs get drawn at all** is a different question, and the merge
had collapsed both onto one accidental ordering. The deliberate
face-vs-panel disagreement recorded in `job-groups.ts` was only ever about the
badge; it survives, narrowed to that.

### M3 — Unread is drawn on the Jobs seat

Not on the face. Staging cleared that corner deliberately (`map-node.tsx:229`),
and past seven agents a badge there degrades to an unlabelled dot on a portrait —
the exact thing that commit removed. The Jobs seat already carries the state
roll-up, so both axes sit on the one object that answers "what is this agent's
work doing".

**Constraint the placement inherits:** the `'new'` tone slice 05 reserved for
unread resolves to `--km-dim`, *the same value as `ok`*
(`knowledge-map.css:215`). Unread and connected are the same grey today. The map
allows only two saturated things — needs-you and running — and unread is news,
not an alarm, so it must be told apart by **shape** (a numeral) rather than hue,
or be given its own value.

### M4 — Every read stamp is gated on visibility

D5–D7 are unchanged: unread is any event advancing `lastEventSeq`, `doc_patch`
included, stamped on view and on every data update. What this walk found is that
the *mechanism* planned for it contradicts the definition.

Unread means **work that finished while you were away**. Slice 07 marks read
whenever the session is mounted and flushes immediately on a terminal event, and
the signal it is modelled on binds `isActive` to `canWrite` — a permission, not
visibility (`session-data.ts:284`). Nothing checks whether anyone is looking.
**An open tab is not presence.**

So: gate every stamp on `document.visibilityState === 'visible'`, terminal flush
included, and **drop the `pagehide` flush** — it exists to catch the tail, and
the tail it catches is exactly the frames nobody read.

Wrong-toward-unread is the safe direction. A badge you clear by looking costs a
click; a badge that never appears means the feature silently did not work.

### M5 — Slice 06b shrinks to one rule

Staging built the chat panel half via the `…/sessions/default` alias
(`acc41ac9`), including the write half without which the pointer is never
stamped. Its reasoning caught a case this spec had not: *an agent starts
conversations of its own*, so no ordering of that list ever means "the chat this
agent is". `order: 'oldest'` **must not be built**.

What remains: the jobs dialog still shows the agent's own chat as a row.

---

## Quadrant 4 — Landmines found by the walk

**L16 — the map cannot show a scheduled job.** `activeJobs` is `state !== 'done'`
so it includes `scheduled`, and the drawer renders those rows with wake times.
But production fetches only `running` and `asking`
(`use-workspace-map.ts:109/114`), so **a job asleep on a clock never reaches the
ring or the drawer.** The playground fixtures supply it directly, which is why
every screenshot shows it working; the jobs dialog fetches all buckets, so the
same job is visible one click deeper.

M1 closes this for free — a per-agent fetch across all unfinished buckets makes
"on a clock" a state production can actually render.

**L17 — the drawer's sort order is computed from a truncated page.**
`WorkspaceMap.activity` is "the newest job in flight per carrier", derived from
the same two pages. The list default is 30 rows
(`session-data.ts:86`), workspace-wide, and `fetchNextPage` is never called — so
on a drive with more than thirty unfinished sessions, an agent whose jobs fall
off page one is **absent from the activity table** and sorts as though it has
never moved. The drawer's headline promise is "most recently active first".

**L16 is closed** — the map reads a third bucket. **L17 is not**: the reads are
still workspace-wide and still one page each, so an agent whose work falls off a
page is drawn with less than it has. Closing that is M1's per-agent read, and
M1 needs a wire filter for "unfinished" first: `bucket` leads the index and a
Convex cursor belongs to one range, so "every unfinished bucket for one agent"
is three requests per face without one. That filter is slice 06's territory.

**The class matters more than either instance:** a fixture that hands a component
state the data layer cannot fetch produces a screenshot of a surface that does
not exist. Nothing in the visual gate can catch it, because the gate renders the
fixture. Both landmines here are that shape, and both were invisible to a green
suite.

**Not a landmine, a relief:** all three surfaces that can show a session — the
sessions route, the map's chat panel, and the jobs dialog — mount the same
`SessionsProduct` (`agents-map.tsx:334`, `:468`). The read signal has one home in
`useSessionDetail`'s stream handler and the other two inherit it. Slice 07 got
easier, not harder.

---

## Quadrant 3 — Unknown knowns

Recorded because they were extracted, not asked for:

- **A count is a claim.** `use-workspace-map.ts` leaves a count `undefined`
  rather than print one it cannot support. Any capped unread count must be
  visually distinguishable from an exact one.
- **One mark per question.** `map-node.tsx` and `live.ts` both refuse to let one
  glyph answer two questions — liveness is drawn alongside every state rather
  than instead of one. M3 obeys this by keeping unread off the face.
- **Decorating the resting case turns a map into a dashboard.** The reason
  `done` is silent, `connected` wears nothing, and unread must be quiet.

---

## Status of this map

Quadrants 1, 2 and 4 are complete. Quadrant 3's placement question is answered
(M3); its two context probes were **already answered in `MAP.md` (D3–D7)** and
should not have been re-asked.
