# 07 — Finished work reaches the numeral, and grows a seat to sit on

> **DROPPED, 2026-08-13. Kept as the record of why.** This slice exists because a
> *count* on the Jobs seat needed finished work to reach it. The seat now carries
> no mark at all (decision 10), so there is nothing for finished unread to reach
> and job-level unread is not on the map — it lives in the dialog, which already
> lists `done` with a dot per row.
>
> **Two hard problems stopped being problems rather than being solved**, which is
> the reason this file is worth keeping: **F13**, an owner whose only unread work
> is finished has no Jobs seat to draw a numeral on; and **F14**, a frontend-only
> finished count cannot be exact because `useSessionList` pages at 30. Both were
> real, both were decided with the user, and both evaporated with the numeral. If
> a count ever returns to this map, they return with it.


Requirement 4. Unread on `done` sessions reaches the Jobs seat's numeral without
drawing a bead that never goes out.

Depends on [04](04-the-unread-axis.md), [05](05-reading-clears-the-numeral.md)
and [06](06-the-chat-leaves-the-seat.md).

## The hole this slice must fill first

Found during planning, verified at source, and **it defeats the requirement as
originally stated**:

`layout.ts:385` sets `working = activeJobs(agent.jobs).length > 0`; `activeJobs`
filters `state !== 'done'`; line 415 returns early when `!working`. So an owner
whose only unread work is **finished** draws no Jobs seat at all — and the
numeral has nowhere to go, in exactly the case requirement 4 exists for.

**Decided with the user: the seat is drawn whenever there is unread.** The seat's
meaning widens from "this agent has work in flight" to "this agent has work,
including work you have not read". It costs one app seat on that agent's row for
work that is over, which is the price of the numeral having somewhere to live.

The condition must read the **count**, not the job list — `activeJobs` filters
done rows out, so a list-derived `working` stays false no matter what joins
`agent.jobs`.

## The API seam

```ts
// knowledge-map-data/use-finished-jobs.ts
/** owner id → the newest page of its finished work, the owner's own chat excluded. */
export type FinishedJobs = ReadonlyMap<string, readonly SessionSummary[]>
export function useFinishedJobs(
  workspaceSlug: string, owners: readonly OwnerRef[], options: { enabled: boolean },
): FinishedJobs
```

One plain (non-infinite) page per drawn owner:
`{ agentId, bucket: 'done', archived: 'exclude', excludeDefault: true }`.

**Its own key, deliberately not the dialog's.** `useQueries` cannot drive
`useInfiniteQuery`, and sharing the dialog's infinite key would make opening the
dialog silently repaginate the ring's numeral. This is a *different question* —
the newest page, for a count — not a second copy of the same one, and the key
must say so.

`Agent` in `types.ts` grows a second set, beside `chat`:

```ts
/**
 * This owner's finished work, counted and never drawn.
 *
 * Separate from `jobs` because `jobs` is what the ring *draws*, and a finished
 * job drawn as a bead is a bead that never goes out. Keeping it out of `jobs`
 * is also what keeps this slice's blast radius to one numeral: no bead, no
 * state badge, no rail row, and no change to the rail's ordering.
 */
finished?: readonly Job[]
```

`unreadOf` for the `jobs` node becomes
`unreadCount(agent.jobs) + unreadCount(agent.finished)` — one counter, one rule
function, two sets.

**Why not merge finished rows into `agent.jobs` and rely on the existing
guards.** `activeJobs`, `STATE.done.rank === 0` and `urgentFirst` would each keep
done rows off the beads, the badge and the rail's row list — but `lastMoved`
would see them, and the rail would reorder when an agent finishes something. That
is a user-visible change nobody asked for. Two sets, one counter, no reorder.

## Resolved here

- The seat is drawn when `unreadOf(seat) > 0` even with nothing in flight.
- Finished rows never enter `agent.jobs`, so `activeJobs`, `attention`,
  `urgentFirst`, `lastMoved` and the rail are all untouched.

## The floor, recorded honestly

`useSessionList` pages at 30 and the map's activity read is bounded at
`SESSION_ACTIVITY_DEFAULT_LIMIT = 24` per owner — two different reads, two
different bounds. An unread finished job with more than a page of *newer*
finished jobs in front of it is not counted.

**Decided with the user: accept and document.** The numeral counts unread across
all in-flight work plus the newest page of finished work. In practice the `9+`
cap absorbs nearly every case — you would need more than a page of finished jobs,
fewer than nine unread on page one, and more unread beyond it. The numeral
understates rather than overstates, which is the safe direction: a number that
claims work that is not there is the worse lie.

`unread.ts`'s comment — which currently promises the numeral is *always exact* —
must be amended to say exactly what it now promises. That amendment is part of
this slice, not a follow-up.

## Verification

- `knowledge-map/unread.test.ts` — the seat counts an unread finished job; a
  finished job that is *read* adds nothing.
- `knowledge-map/layout.test.ts` — an owner with five finished jobs and one
  running draws **one** bead; an owner with three unread finished jobs and
  nothing in flight draws **a Jobs seat with no beads** and a numeral of `3`; an
  owner with three *read* finished jobs and nothing in flight draws **no seat**.
- `agents-rail/roster.test.ts` — `active` unchanged by finished rows, **and**
  order unchanged. Both assertions, so "the rail does not move" is pinned rather
  than assumed.
- `framing.test.ts` / `type-scale.test.ts` — a seat that now appears where it did
  not spends a slot; re-run the fleet sizes with a finished-only owner in the
  fixture and confirm the arc and the caption floor still hold. **This is the
  slice's real geometry risk** and it is not obvious: the seat takes an app's
  place (decision 1), so an owner with four apps and finished-only unread draws
  one app fewer than it does today.
- `use-workspace-map.test.tsx` — request count 3 + 2N, stated in a comment.
- `bun ui:check knowledge-map-jobs` against 04's baseline, pixels diffed and
  looked at. Unprimed
  [`screenshot-critique`](../../../.agents/skills/screenshot-critique/SKILL.md)
  on a ring where one agent's seat exists solely for finished work: *does a Jobs
  seat with no beads read as an agent with work, or as a bug?*

## Must stay green

`use-agent-jobs.test.tsx`; the whole geometry suite.

## What feedback would change this slice

If a seat with no beads reads as broken, the alternative the user rejected —
finished unread stays invisible until something is in flight — is a one-line
revert of the seat condition, and this slice is deliberately shaped so that is
the only line that moves.
