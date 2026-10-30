# The URL map

Every state the agent surface can be in is a state a link can name. Clicking a
face unfolds that agent over the canvas and the address bar says so; the card it
opens on and the work dialog over it are two siblings one segment further in,
never both at once. Four pieces of React state — the zoom, the card, the jobs
dialog and the job inside it — left the route for the path. A fifth, the roster
drawer, left it for the reader: it became the rail's stored preference.

**Why this existed.** Duet's surfaces were addressable right up until the one
that matters most. The drive was deep-linkable to a single file
([`drive-deep-links`](../drive-deep-links/README.md)); the *agent* — the thing
the whole product is about, the thing an agent writes a link to — was not
addressable at all. Worse, `/agents/:agentSlug` was already taken by the
configuration document, and
[`manage-agents`](../../../packages/skills-registry/skills/manage-agents/SKILL.md)
instructed every agent to write exactly that path when naming a colleague. The
one link agents *did* emit landed on the surface the reader did not mean.

This work absorbed slices 01–03 of
[`agent-jobs-on-the-map`](../../agent-jobs-on-the-map/README.md), which had
specified the same grammar at a narrower scope.

---

## The rule

**A path segment names a subject the drive has; a query names how you are
looking at it.**

An agent, one of its apps, its folder, one of its sessions — each is a thing this
drive contains, so each is a segment. The camera coming closer to one agent's
work is not: nothing new is on screen and nothing is unfolded, so the place is
still the ring and `?branch=` says where you are standing on it. That split is
what lets `/agents/ops` keep exactly one meaning — Ops unfolded — instead of also
having to mean "Ops, but not unfolded".

The grammar itself is not reproduced here. It is one pure module with a header
that states it, and the module is the only thing allowed to be right about it:
[`spa/drive/agents-map-url.ts`](../../../apps/web/spa/drive/agents-map-url.ts).

---

## Invariants

These are the rules the implementation must keep honoring. Each names the seam
that notices when it stops being true.

1. **One owner for the grammar.** `agents-map-url.ts` builds and parses every
   map URL. Four hand-rolled copies of "which paths are the map" used to be
   spread over three modules — two regexes, a pattern table and a segment walk —
   and every miss was silent: the canvas rendered as a document, the Agents tab
   went dark, or the loading frame was somebody else's. `isDriveCanvasPath`,
   `driveTabForPath` and the cold skeleton (`loading/loading-route.ts`) all ask
   `isMapPath`; `driveCanvasPattern` is deleted and `drivePathPatterns` no
   longer describes the canvas. What survives of that pattern still drifted:
   it carried an `agents/:slug/chat` alternative for a route nothing mounts, so
   the Agents tab lit for a path that renders not-found — pinned, for a while, by
   a test asserting the drift. Removed. This is what the invariant costs when
   only one of the copies is deleted.
2. **The map route holds no *place* state.** Where the reader is — which agent
   is unfolded, which card, which dialog, which session in it — is read from the
   URL and stored nowhere. Three pieces of React state survive on
   [`agents-map.tsx`](../../../apps/web/spa/routes/agents-map.tsx) and none of
   them is a place: `railHover` (which row the pointer is on, the one fact the
   list and the picture both need and neither owns), `useRailOpen` and
   `useHeaderRow`. The last two are reader preferences persisted to
   `localStorage` — furniture and arrangement, per reader rather than per drive
   — and invariant 10 is the test they have to pass to be allowed to stay out of
   the URL. Note that `useHeaderRow` is not purely cosmetic: it decides which
   explicit card URL a bare `…/agents/:slug` entry redirects to. The naked URL
   never renders a default card of its own.
3. **`SessionsRouting.session` returns the place the reader is already on.**
   This is the trap the build had to disarm, not a nicety. While the zoom was
   state, that call answering `/agents` changed the URL and nothing on screen.
   The instant the zoom *is* the URL, the same call folds the agent away under
   the reader's hands on the most common action the surface has — typing the
   first message. A host that mounts the sessions surface elsewhere supplies its
   own routes; the map supplies `() => here`.
4. **Places push, lenses replace.** Entering an agent, leaving it, opening and
   closing the work dialog are pushes — so Back reopens what you just shut.
   Picking a different session in the dialog, a different card in the row, or a
   different bead on the same branch replaces. Holding Back walks agent → ring,
   never through five apps you glanced at.
   The seam is `movesTheReader` in `sessions.tsx`: a host may answer `routes`
   with the place the reader is already on, and both navigations on that surface
   ask before moving. They were not always both asking — the callback that mints
   a session pushed unconditionally, which on the map meant a history entry onto
   the URL you were already on, so Back spent a press and changed nothing on the
   most common action the surface has. One predicate, two callers, differing
   only in push versus replace.
5. **The card and the dialog are siblings, never nested.**
   `…/ops/apps/invoices` and `…/ops/sessions/s_42` are two children of one agent
   and the URL cannot be on both. The dialog is modal, so the states are
   exclusive on screen and the grammar says the same thing. The cost is stated
   in the module header and accepted: close the dialog and the card returns to
   the reader's first usable arranged item. The bare agent entry resolves and
   replaces itself with that item's explicit URL, so no visible card depends on
   an address that fails to say which card it is.
6. **A named thing that is missing is said out loud; a lens that is missing
   degrades.** An unfolded agent this drive does not have is `unknown` — the
   whole destination is lost. A `?branch=` naming an absent agent falls back to
   the plain ring, because the reader asked to look *closer at* something and the
   picture they were already on is the honest answer. A named session on the
   wrong agent says `elsewhere` rather than quietly showing a different
   conversation.
7. **`waiting` and `unknown` are different answers.** A cold deep link and a
   dead link look identical for the first few hundred milliseconds. Only a
   settled read may call an agent missing; an errored read is `waiting`, because
   a request that timed out has established nothing about who is on this drive.
8. **The map is one mounted route.** `PRODUCT_DESTINATIONS` gives it a single
   `agents/*` splat rather than the six patterns the grammar has, so every shape
   of map URL renders the same mounted element and a flight into a face cannot
   remount the canvas mid-animation. `route-metadata.test.ts` pins the table
   shape — one splat, the agent document beside it — but nothing pins the
   *consequence*, that the element mounts once; that stays a constraint the
   table's comment carries and a reviewer has to keep.
9. ~~**The order of `PRODUCT_DESTINATIONS` is load-bearing.**~~ *Retired days
   after this shipped, and worth keeping as a warning about how a rule outlives
   its reason.* The rule was real: `routeTitleKey` matched the table
   first-to-last, so `agents/*` declared above `agents/marketplace` silently
   retitled the catalog. But its last product caller — a heading in the
   workspace shell — had been gone for months, leaving the function exercised
   only by its own test, which is the shape that lets dead code look alive.
   `routeTitleKey` and every `titleKey` feeding it were deleted in
   `14c05548`, and the table's ordering note now says so. Both surviving readers
   ignore order: React Router ranks by specificity, and the deployed route
   manifest only maps. A table whose order quietly stopped mattering is one
   somebody re-sorts in fear.
10. **The roster rail is deliberately not addressable.** It is furniture. Whether
    a column is out is a working preference — per reader, not per drive — and a
    link that lands somebody on a rail over a drive they have never seen is a
    link about somebody else's furniture. Stored in `localStorage`, closed until
    asked, and every path through it is total because a browser is allowed to
    refuse storage outright.

---

## Where it lives

| concept | owner |
|---|---|
| what a map URL looks like — building and parsing | [`spa/drive/agents-map-url.ts`](../../../apps/web/spa/drive/agents-map-url.ts) (pure) |
| which agent a place unfolds, against live data | [`agents-map/where.ts#focusOf`](../../../apps/web/spa/routes/agents-map/where.ts) |
| which card the URL shows, against the app list | [`agent-surface/stage.ts#showingOf`](../../../apps/web/spa/routes/agents-map/agent-surface/stage.ts) |
| which session the dialog's pane is on | [`agent-jobs/showing.ts#jobsShowingOf`](../../../apps/web/spa/routes/agents-map/agent-jobs/showing.ts) |
| canvas / tab / skeleton — all three ask `isMapPath` | [`spa/drive/drive-routes.ts`](../../../apps/web/spa/drive/drive-routes.ts) |
| the destination table and its order | [`spa/routes/product-destinations.ts`](../../../apps/web/spa/routes/product-destinations.ts) |
| Train's scope grammar | [`routes/train/train-routes.ts`](../../../apps/web/spa/routes/train/train-routes.ts) |
| whether the rail is out | [`agents-rail/open-state.ts`](../../../apps/web/spa/routes/agents-map/agents-rail/open-state.ts) |
| navigation, push/replace, and the sessions promise | [`spa/routes/agents-map.tsx`](../../../apps/web/spa/routes/agents-map.tsx) |
| the links agents are told to write | [`manage-agents/SKILL.md`](../../../packages/skills-registry/skills/manage-agents/SKILL.md) |

Every *pure* owner above is pinned by a `*.test.ts` beside it. The two that are
not are the ones whose gaps this record names: `agents-map.tsx` has no test file
at all — which is why invariant 4's leak and invariant 8's one-mount rule are
unpinned — and `manage-agents/SKILL.md` is prose. The grammar's own test is
[`agents-map-url.test.ts`](../../../apps/web/spa/drive/agents-map-url.test.ts);
the one that pins the router's flattened table — one splat for the map, a
session address that stays, an app address that must not come back — is
[`route-metadata.test.ts`](../../../apps/web/spa/routes/route-metadata.test.ts).

---

## Where the build diverged from the plan

The plan was written before the code; these are the places reality answered
differently, and they are the reason this record exists.

- **`computer/` left the address bar entirely.** The plan called the bucket
  "coherent and worth keeping" and only argued about what belonged inside it.
  The build deleted the prefix: `computer/files/*` → `files/*`,
  `computer/integrations` → `integrations`, `computer/train/…` → `train/…`. The
  distinction it drew — the machine's disk, memory and plugs, versus the work on
  top — was never visible to a reader, because nothing in the product says the
  word "computer". A segment nobody could read was a segment nobody could
  navigate by. One producer of the old path outlived the cutover by four days:
  the Composio OAuth callback's fallback destination, taken when the caller
  supplies no `redirectTo`, still sent an agent-initiated connect to
  `/w/:ws/computer/integrations` — a path the SPA answers with its not-found
  route. Repaired at close (`apps/api/src/routes/composio.ts`).
- **The drive-wide Jobs list was deleted, not renamed.** The plan moved
  `/w/:ws/jobs` to `/w/:ws/sessions` as a table. What shipped has no drive-wide
  list at all: work is a session, a session belongs to an agent, and an agent's
  work is read on that agent's own surface. The tab bar is three tabs, and no
  *list* in this product is missing a button.
- **…and one of the two addresses survived, doorless.** The cutover deleted the
  workspace-level `sessions` and `apps` destinations outright; a follow-up put
  both back on the plan's settled decision 3, that a link already written must
  open the thing it names. Only the session half held.
  `/w/:ws/sessions/:sessionId` is the durable name of one record — the shape
  every session link already in the world was written in, and what the
  post-create redirect leans on — reached by link, never by the bar.
  `/w/:ws/apps` and `/w/:ws/apps/:appSlug` were deleted again in `f5328499` /
  `8db348a3`, and that is the better answer: **an app has one address**, on its
  agent's card at `…/agents/:agentSlug/apps/:appSlug`, with the controls that
  lived on the workspace page moved to the ⋯ menu on the chip that names it. Two
  addresses for one subject is exactly what this document exists to notice, so
  decision 3's apps half is closed by deletion rather than by the door it asked
  for.
- **`root` is not a reserved word.** The plan reserved `marketplace` and `root`
  under `/agents`. Only `marketplace` is. `root` is the drive's own agent — a
  real subject with a real place on the map, answering to the token the contract
  already spends (`ROOT_AGENT_SCOPE`) — so `focusOf` resolves it to the centre
  rather than the parser refusing it.
- **Reservation is enforced by the parser, not at registration.** A reserved word
  never resolves to an agent, so an agent that took one would simply be an agent
  no URL could address. The plan shipped a second guard for this —
  `isReservedAgentSegment`, over `files`, `apps`, `sessions`, `settings`, `train`
  and `marketplace` — which no caller ever arrived for; it has since been
  deleted, along with the `AGENT_SEGMENTS` set that only it read. Deleting it
  cost nothing, because five of those six words cannot collide anyway: they are
  segments *under* an agent, and the grammar reaches them through a fixed
  position (`…/agents/ops/files`), never by matching a name. That short Files
  entry resolves the registered anchor and redirects to the explicit
  `…/files/<path>` form. Its trailing segments then name the exact Drive
  file or folder currently open, so an agent can deep-link a reader without
  replacing the surrounding agent surface. No marker segment separates Files
  from the Drive path: the fixed `files` namespace already provides that
  boundary, while an empty tail is the short entry that resolves to the agent's
  registered folder.

  **`marketplace` is the one that can, and the hole is still open.** An agent
  slug is an `AppSlugSchema`, so registration refuses the contract's
  `RESERVED_SLUGS` — which covers `apps`, `settings` and `root` but not
  `marketplace`. Register an agent as `marketplace` and it is accepted, then
  permanently unaddressable: the parser refuses the word and the route serves the
  catalog. Closing it means adding one word to `packages/contract/src/slug`,
  which is deliberately *not* done here: that list is shared by workspace, app
  and publish slugs and is parsed on read paths as well as writes, so widening it
  could orphan an existing record. It is a data question before it is a code one.
- **`?agent=` survived, as a slug, on `/sessions/new`.** The plan's decision 4
  was about a drive-wide list that no longer exists, but the one-word-one-grammar
  half of it holds: the deep link is `?agent=<slug>`, `root` included, and the
  web app never sends an agent id. `/sessions/default?agent=` joined it as the
  owner's-default-chat alias.
- **No dedicated staging journey was registered, and the coverage is thinner
  than it looks.** The build order called for one; there is no `url-map` entry in
  [`staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic).
  Of the journeys that appear to cover it, three drive a real browser at these
  addresses: `drive-deep-links` (the emitted-href side), `sessions-and-jobs`
  (`/w/:ws/sessions/:id`) and `agent-onboarding` (the bare ring). `agent-delegation`'s
  `…/agents/<slug>/sessions/default` is the **API** path under `${apiUrl}/v1/ws/`
  — the same shape by coincidence, exercising none of `agents-map-url.ts`. No
  live journey opens an agent by URL, picks a card, or opens the dialog. That is
  the gap this close leaves open.

---

## Dead ends

Approaches tried or specified and rejected, so nobody re-walks them.

- **Keeping the zoom in React state.** The original argument — the map is one
  surface, so a conversation started inside it must not teleport you out of the
  picture you opened it from — was right about the danger and wrong about the
  remedy. It is an argument against navigating to `/sessions/:id`, not against
  having an address. Invariant 3 keeps the promise without costing the address.
- **`zoom` holding `node.data`.** A click-time snapshot of the agent, which meant
  an agent's work never updated while you were inside it. Resolving a slug per
  render against the live projection fixes it for free.
- **Configuration at `/computer/agents/:agentSlug`** (decision 7 of the prior
  plan). It kept the `computer/` bucket coherent at the cost of splitting "about
  this agent" across two roots. Everything about an agent lives under that agent:
  `/agents/:agentSlug/settings`. Hard cutover, no compatibility redirect — a
  stale configuration link lands on the agent, which is a better wrong answer
  than a 404 and not worth a permanent branch in the parser.
- **Root as the *absence* of a Train scope.** Bare `computer/train` meant the
  drive, which made it the one row in the picker no link could select, and forced
  a static `agents/` segment to keep `train/support-handbook` (a root memory)
  from colliding with `train/agents/research` (an agent). Naming root fixes both
  and costs one segment; bare `/train` now redirects to `/train/root`.
- **Falling through to a default when a *named* session is missing.** Right while
  the pick could only have come from a row the reader just clicked; wrong for a
  URL. One link would open on something different for each person it was sent to.
  Invariant 6 is what replaced it.

One rule was *inherited* rather than discovered here, and is worth naming because
it constrained the design: the card and the dialog's pane were already
null-until-chosen rather than seeded from data, because an effect that writes
state from data is how a card ends up on an app the reader has already navigated
away from. Putting the choice in the URL had to preserve that — a URL is not
seeding from data, it is the reader's choice arriving through a different door —
and that is why `showingOf` and `jobsShowingOf` return "no choice" rather than a
default.

---

## Visual provenance

No reference imagery of its own: nothing here was built to match a mock. The look
this work had to hold still is
[`agent-jobs-on-the-map`](../../agent-jobs-on-the-map/README.md)'s, whose
`assets/` are where the ring, its finishes and its toolbar were decided.

It did move pixels in one place, and the baselines record it. The roster **drawer
became a rail** — the visible consequence of deciding that furniture is not
addressable — so the cutover deleted `agents-drawer{,-open,-states}` and added
`agents-rail{,-inside,-open,-states}` in both desktop and mobile, deleted
`spa-shell-jobs{,-history,-loading}` with the drive-wide list, and re-shot the
`sessions-quality-*` trio. The follow-up that restored the doorless full-page
addresses re-approved the rest and recorded the Docker visual gate green at
157/157. Anything under
`apps/web/tests/visual/__screenshots__/**/agents-rail*.png` was first shot here.
Later commits have re-approved some of them since — `git log` on a baseline is
the only honest answer to who owns its current pixels.
