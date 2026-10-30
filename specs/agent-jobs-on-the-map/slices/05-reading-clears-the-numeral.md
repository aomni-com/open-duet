# 05 — Reading a session clears it everywhere it is drawn

**This is a live defect, found during planning and verified at source.** It ships
today on the Jobs seat. It is first in the ladder because the face's numeral is
the one you clear *by clicking the face*, so shipping the headline feature on top
of it would make the feature actively wrong.

## The defect

`sessionKeys.activity` is deliberately outside `sessionKeys.lists()` — with a
comment saying so (`api/query-keys.ts:120-122`):

> *Not under `list`: it is a different family with no filters and no cursor, and
> putting it there would make `lists()` invalidate it.*

`sessionKeys.default` is its own family too. But `commitSessionSummaryFields`
(`sessions/session-cache.ts:49`) — what marks a session read — writes
`sessionKeys.detail` and then calls `patchSessionListCaches`, which searches
`findAll({ queryKey: sessionKeys.lists(workspaceSlug) })` and nothing else.

So marking a session read reaches `detail` and `lists`, and **never** the map's
feed or the default-chat entry. Read a job in the dialog, close it, and the Jobs
seat numeral is still lit until a window-focus refetch happens to fire.

Invisible to the type checker. Invisible to the visual gate. Nobody has named it.

## Contract unlocked

Any surface may draw `unread` from `activity` or `default` and trust that reading
clears it. Slices 06 and 07 depend on this and must not ship before it.

## The API seam

`sessions/session-cache.ts` grows two more families. No new exports at the module
boundary — `session-reads.ts` is untouched, because the bug is not in what stamps
a read, it is in what the stamp reaches.

The module keeps its existing role: **the one owner of "which caches a session
summary lives in."** It has silently missed two families since they were added,
which is exactly the failure mode a single owner is supposed to prevent — so the
fix is to complete the owner, not to add a second patcher beside it.

## Resolved here

**Patch, never invalidate.** Invalidating `activity` would refetch every owner's
work to clear one dot. The write is a targeted `setQueryData` on the entries that
hold that session, the same way the list families are already handled.

## Verification

Red test first, in `sessions/session-cache.test.ts`:

- Seed a query client with an `activity` response, a `default` snapshot, and a
  `detail` entry, all holding `unread: true` for `s_1`.
- Stamp `s_1` read via `commitSessionSummaryFields(…, ['unread'])`.
- Assert all three now read `false`.

Today the first two stay `true`. That is the red.

Then the behavioural one: reading a session must **not** move it. The existing
invariant — `commitSessionSummaryFields` deliberately does not carry `updatedAt`,
or every recency-ordered list would reshuffle the instant someone looked — has to
survive into the two new families. Assert `updatedAt` unchanged on the activity
row after a read stamp.

## What a human sees

Open a job from the ring, read it, close the dialog. The Jobs seat numeral drops
immediately instead of whenever the window next regains focus.

## Must stay green

`apps/web/spa/sessions/*.test.ts` in full — especially `session-reads.test.ts`,
whose coalescing-window and visibility-gating invariants this must not disturb.
`bun --cwd=apps/web run test`.

## Delegated

Nothing. The seam, the fix and the test are all named.

## What feedback would change this slice

If patching `activity` in place fights the projection memo in
`use-workspace-map.ts` (which memoises on the activity `Map`), the fallback is to
rebuild the map entry rather than mutate it. It should not — `setQueryData`
produces a new object and the memo re-runs — and the test above proves it either
way.
