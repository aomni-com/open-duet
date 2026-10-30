# 06 — The owner's own chat leaves the Jobs seat and lands on the face

> **Superseded 2026-08-20.** This slice shipped as described and was then
> un-reversed: the split it makes on the client is the wire's now
> (`AgentActivitySchema.chat`), `use-default-chats.ts` is deleted, and
> `splitChat` no longer filters. The API seam, the `DefaultChats` map and the
> `lastMoved(slice.jobs)` note below all describe code that no longer exists —
> kept because the *reason* the chat leaves the seat is unchanged and is what
> the replacement had to preserve. See [`## Reversals`](../README.md#reversals).

Requirements 1 and 2, **together, because they are one fact.** The face's numeral
becomes real and the Jobs seat's stops counting a row the dialog it opens does
not have. Shipping either alone leaves the map lying in a new way: change 1
without change 2 double-counts the chat; change 2 without change 1 deletes a
signal without replacing it.

Depends on [04](04-the-unread-axis.md) (the rule and the mark) and
[05](05-reading-clears-the-numeral.md) (or the numeral never clears).

## The live defect this closes

`sessionActivityImpl` does **not** exclude the default chat; the jobs dialog does
(`excludeDefault: true`, `use-agent-jobs.ts`). So an unread default chat inflates
the Jobs numeral *and* draws a bead — and the dialog that bead opens has no such
row. A numeral pointing at a door with nothing behind it.

## The API seam

```ts
// knowledge-map-data/use-default-chats.ts
/** `id` keys the map; `slug` addresses the alias. Root is `root` for both. */
export type OwnerRef = { id: string; slug: string }
/** owner id → its default chat's own row. Absent means no default chat yet, or the read failed. */
export type DefaultChats = ReadonlyMap<string, SessionSummary>
export function useDefaultChats(
  workspaceSlug: string,
  owners: readonly OwnerRef[],
  options: { enabled: boolean },
): DefaultChats
```

`useQueries` over the existing `defaultChatQueryOptions(api, workspaceSlug, slug)`
— not a new query options factory, because the agent surface already reads that
key and the map should warm the entry it will need rather than mint a parallel
one.

- `hasNoDefaultChat(error)` → absent. **A 404 is this read's success case**, the
  ordinary state of an owner nobody has written to.
- Any other failure → also absent. A numeral is a claim; a failed read makes
  none. A read that failed must never be drawn as an empty list.
- `enabled: canUseSessions`, or the fan-out is N 403s.
- **Drawn owners only** — `map.data.agents` plus `ROOT_AGENT_SCOPE`, never the
  500-agent census. A nested agent has no face on the ring, so asking buys
  nothing.

The projection is where the split happens, and it is the single owner of "which
session is the default chat" on the client:

```ts
// knowledge-map-data/project.ts
export type AgentSlice = {
  agent: Agent; apps: readonly App[]; jobs: readonly SessionSummary[]
  /** the alias's answer, and the ONLY source for this record */
  chat?: SessionSummary
}
```

- `chat` is built **from `slice.chat` only** — never from the feed's copy of the
  same row, even when the feed has it. Two producers of one record is drift with
  extra steps. The alias owns it.
- `jobs` becomes `slice.jobs.filter(s => s.id !== slice.chat?.id)`, which removes
  the inflated count **and** the phantom bead in one move.
- `lastMoved` keeps reading `slice.jobs` **before** the split, so rail order does
  not move in this slice.

`live.ts` — `agentIsLive` / `liveWork` read `chat` alongside `jobs`, which
**preserves today's behaviour exactly**: a running default chat lights the rim
today because it is in the feed, and it must keep doing so. Document it as the
deliberate difference between two questions — *working* is about the agent, the
seat's numeral is about the dialog's list.

`use-workspace-map.ts` composes, and the new read **does not join `arrived`**.
The picture is three requests; numerals fill in behind it.

## Resolved here

- The alias is the sole source of the chat record.
- The read never gates `arrived`.
- Freshness belongs on `defaultChatQueryOptions` itself, not at this call site.
  The map and `routes/sessions.tsx` share that key; two consumers with two
  policies is a second owner for "how fresh is the chat".

## Delegated

**The flicker.** While the alias is in flight, a chat sitting in an unfinished
bucket is still drawn as a bead. Rare — only while the chat is actively
running/asking/scheduled — and self-correcting. The alternative is withholding
beads on the whole ring until N reads answer, which is worse. Record it; do not
build for it.

## Verification

- `knowledge-map-data/project.test.ts` — the split is total and pure, from
  fixtures, no network: the chat's id never appears in `MapAgent.jobs`; `chat`
  carries the alias's row even when the feed holds the same id with a different
  `unread`; an absent `slice.chat` leaves `jobs` byte-identical; `toDuet` behaves
  identically for `ROOT_AGENT_SCOPE`.
- `use-default-chats.test.tsx` — one request per drawn owner and no more; keys by
  owner **id** while addressing by **slug** (root is the trap: keyed `root`,
  addressed `root`); 404 → absent, not an error; 500 → absent; `enabled: false`
  asks nothing.
- `use-workspace-map.test.tsx` — **the request-count assertion changes from 3 to
  3 + N, and says why in a comment.** That test is the tripwire the module exists
  for; it going red here is the design working, not a break.
- `knowledge-map/live.test.ts` — a running chat lights the rim and is absent from
  the seat's numeral.
- `knowledge-map/unread.test.ts` — the regression case, named for the defect: an
  owner whose only unread session is its default chat draws `1` on the face and
  `0` on the seat.

## Must stay green

`agent-jobs/use-agent-jobs.test.tsx` — the dialog's `excludeDefault` invariant.
The map now agrees with it instead of contradicting it. `roster.test.ts` — order
unchanged in this slice.

## What a human sees

A real drive: an unread default chat draws `(1)` on the face, and no longer
inflates the Jobs numeral or draws a bead the dialog has no row for.

## What feedback would change this slice

If the per-owner fan-out measures unaffordable on the landing page's critical
path, the fallbacks in order: ask only for owners currently on screen; then
accept a stale-until-focus badge. The named redemption is one line in
`activity.ts` — see the README's blocker on the 2N cost.
