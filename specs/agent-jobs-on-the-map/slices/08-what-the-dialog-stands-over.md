# 08 — The dialog says what it stands over

**Contract unlocked.** The jobs dialog becomes addressable over the ring without
a second owner for "the dialog is open". Nothing writes the new spelling yet, so
this slice is verifiable by URL alone — no clicks change until
[09](09-one-click-opens-it.md).

Independent of 04–07; it touches no data.

## Why this is a two-axis change and not a `focusOf` tweak

The obvious move is "make a `sessions` place stop unfolding the agent". It cannot
be unconditional, because `AgentSurface` keeps its **own** Jobs door
(`agent-surface/parts.tsx`, fed by `jobsHref` at `agents-map.tsx:289`) pointing at
the same place. Following that link would fold away the very surface it was
clicked on.

So the fact that needs an owner is not *does the dialog unfold* but **what the
dialog stands over** — a second axis. `focusOf` must grow rather than change its
answer.

## The API seam

```ts
// drive/agents-map-url.ts
export type MapPlace =
  | { kind: 'ring' }
  | { kind: 'agent'; agentSlug: string; card: MapCard }
  /** The jobs dialog, and what it is drawn over. One kind, because there is one dialog. */
  | { kind: 'sessions'; agentSlug: string; sessionId: string | null; over: 'ring' | 'agent' }
  // 'branch' — deleted
```

- `over: 'agent'` writes the path form `…/agents/ops/sessions[/s_42]`, unchanged.
- `over: 'ring'` writes the query form `…/agents?jobs=ops[&session=s_42]`, in the
  slot `?branch=` vacates, under the grammar rule already written into that
  file's header: **a path segment names a subject on screen, a query names how
  you are looking at the place.** The ring with one agent's work open over it is
  still the ring.

`MapPlace.branch` is *replaced*, not merely deleted — its query slot and its own
doc argument ("the place is still the ring; `?branch=` says where you are
standing on it") are precisely what the ring-form dialog needs. Swapping
`?branch=` for `?jobs=` in one commit is an unconditional replacement, which
satisfies the README's "no transitional seams" rather than bending it.

```ts
// routes/agents-map/where.ts
export type JobsOpen = {
  agent: MapAgent; agentSlug: string; sessionId: string | null; over: 'ring' | 'agent'
}
/** What the canvas draws, and what stands over it. Two questions, answered once. */
export type MapView = { focus: MapFocus; jobs: JobsOpen | null }
export function viewOf(place: MapPlace, map: MapProjection, phase: Phase): MapView
```

`focusOf` is absorbed. Its doc comment — *"the dialog is drawn over that agent's
surface, so the URL naming a job has to unfold the agent whose job it is"* — is
**replaced by the two-axis argument, not deleted.** A reader who knows this file
must be told the reasoning changed.

Resolution rules, all pure:

- `over: 'ring'` → `focus` is always `{kind:'ring'}`; `jobs` is `null` until the
  agent resolves. A dialog whose agent has not arrived draws nothing over a ring
  that is already correct — strictly better than today's `waiting`, which blanks
  the canvas.
- `over: 'agent'` → `focus` unchanged (`agent` / `core` / `waiting` / `unknown`).
- `ROOT_AGENT_SCOPE` resolves for both spellings. The early return at
  `where.ts:75` must stop swallowing the place kind: today `/agents/root/sessions`
  returns `{kind:'core'}` and the dialog's open-ness is read separately, which is
  the second owner this slice deletes.

## The two route-level traps

Both are load-bearing and neither is caught by the compiler.

1. **`jobsAbout` is derived from `focus`** (`agents-map.tsx:569-577`). After this
   slice `focus` is `ring` while the dialog is open over the ring, so a
   `focus`-derived scope would be `null` and the dialog would ask for nothing.
   `viewOf` makes that impossible by construction — `jobsAbout` reads
   `view.jobs`.
2. **`agentScope` (`:307`) does double duty**, meaning both "the unfolded agent,
   for the left column's alias" and "the dialog's agent, for its right pane and
   its `go()` calls". Those are the same agent today and **different agents after
   this slice.** Split into `surfaceSlug` (from `view.focus`) and
   `view.jobs.agentSlug`, and re-point every dialog callback — `onOpenChange`,
   `onPick`, `onBack`, `onPutAway`, and `mountSession`'s `agentSlug` — at the
   latter. Both are `string | undefined`; `check-types` will not help. This wants
   a deliberate read of every use site, not a rename.

`jobsOpen` and `picked` (`:582-583`) are deleted; they become reads off
`view.jobs`.

## Resolved here

- Two spellings, one kind, one `over`. Each writer owns exactly one `over`
  (see [09](09-one-click-opens-it.md)), so nothing needs to remember where a
  click came from.
- The ring spelling degrades to the ring, never to a notice.
- **Closing goes back to what it stood over.** `over: 'ring'` closes to the ring;
  `over: 'agent'` closes to that agent. `navigate(-1)` was considered and
  rejected: picking a job inside the dialog `replace`s, so a captured navigation
  type is wrong by the time you close — a second place for one fact to be wrong.

## Delegated to the user, not the implementer

Collapsing to one spelling by deleting the agent surface's Jobs door. It is one
fewer concept and one capability less. **Recommendation: keep both.** The
recorded alternative is that the in-agent door becomes an honest departure —
which the user should be shown before it is chosen, because it is the one
behaviour someone could reasonably call a regression.

## Verification

- `drive/agents-map-url.test.ts` — both spellings round-trip through
  `agentsMapUrl` / `mapPlaceOf`; a stale `?branch=ops` parses as the plain ring
  (decision 8's hard cutover, no redirect, no notice); `?jobs=` with an empty
  value is the ring; neither spelling can be written for the other's `over`.
- `routes/agents-map/where.test.ts` — the ring spelling unfolds nobody at any
  phase; the agent spelling still unfolds, including `core`; `jobs` is null while
  the agent is unresolved and non-null the moment it resolves, for both
  spellings; an unknown agent degrades the way its `over` says.

## Must stay green

`route-metadata.test.ts` (F9's tripwire), `loading-route`, and the four modules
of F7 — none of which see a new *path*, which is part of why the query form is
the cheap one.

## What a human sees

Paste `?jobs=ops` — the dialog over the ring. `/agents/ops/sessions` — unchanged,
over the surface. Closing each returns where it came from.
