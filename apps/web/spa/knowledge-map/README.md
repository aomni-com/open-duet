# Knowledge map

A portrait of a drive rather than a list of it — **one destination among
several** under `/agents`, at its own segment, rather than what that path means.
The roster column beside it belongs to the section rather than to this canvas
(see the Agents bullets in [`apps/web/README.md`](../../README.md)); everything
below is about the picture itself.

Core knowledge sits at the
centre with Duet standing on it, agents ring it, and every agent carries one row
of seats: the apps it can reach, one node for however many are left, and — when
it has recent work — a Jobs seat in the middle of them. The jobs themselves
hang off that seat in a second row, which is the only place on this map where
anything has a grandparent. Five fit: needs-you, running, and scheduled work
take priority, then the newest completed sessions fill the remaining seats.

The row is **four seats wide at every fleet size**, and that is load-bearing
rather than tidy: the ring's minimum radius and its arc per slot are both solved
against a four-seat fan. So Jobs takes a seat rather than adding one, and an
agent with recent work shows one app fewer. `branchOf` is where that is
spelled out.

A face wears its name, and under it the slug — but only for an agent somebody
has actually renamed. Unnamed, the two words are the same word, and the map
would be saying it twice under every face on a fresh drive. Which of those is
true is a naming question rather than a drawing one, so it is settled once in
the projection and arrives here as `Agent.subtitle`: present means draw a second
line, absent means there is none. The slug the _router_ travels on is a
different thing and stays in `WorkspaceMap.routes`.

Duet is one of those carriers. It is the drive itself rather than a row in it,
so it never appears on the ring — but the apps no agent's folder encloses are
its own, and they hang off the centre by the same three-and-a-count rule. That
is what `MapData`'s `duet` is for, and it is why the map can be counted: every
app on the drive has a carrier, so the caption under the centre says what the
picture beside it holds.

Everything else about an agent is _inside_ it, and "inside" is now a **route**:
clicking a face navigates to `/agents/:agentSlug`, this canvas unmounts, and the
agent's own page mounts (`routes/agent-route.tsx`). Nothing unfolds over the
canvas any more.

```tsx
<KnowledgeMap
  data={data}
  onZoom={agent => navigate(urlFor(agent))}
  onOpen={event => openApp(event.app)}
  onAddAgent={openAddDialog}
/>
```

It owns no data, fetches nothing, and performs no navigation: it reports what
you clicked and lets the host above decide what that means.

⚠️ The `zoom` prop, the surface it unfolded, the hole that surface left for the
face, and `carriedBy` — which put an agent's own nodes away while you were
inside it — are all still here, and **no production caller uses any of them**.
The ring passes no `zoom`, so it is always null outside the two playground
fixtures that still drive the old shape. It is dead capability on a canvas whose
frame budget is its whole design; deleting it is the next cut, and this note is
here so nobody reads the machinery as load-bearing in the meantime.

The host keeps the root picture fresh through one workspace-wide activity read,
not a poll per face. It watches closely while the ring is visible—even when
the last answer was quiet, because that is how work started elsewhere is
discovered—and slows while an agent surface hides the ring. Activity owned by an
agent absent from the cached roster is also evidence that the roster is stale, so
the host refreshes the roster before projecting that activity onto a face.

The surface that unfolds leaves a _hole_ for the face the camera flew into, and
the camera aims at that hole rather than at the middle of the screen — see
`WELL` in `knowledge-map.tsx` and `--km-well` in the stylesheet. That is what
makes the flight land on the thing you clicked instead of replacing it with a
small copy in a card.

`components/playground/knowledge-map-playground.tsx` is the smallest host.
Everything else is optional: `duetAvatarSrc` overrides the mascot path,
`onSettled` fires when the opening animation comes to rest, `className` is
merged onto the root.

The map is the one destination the product shell treats as a _canvas_: the
window's top bar is frosted glass floating over it rather than a band above it,
so the canvas runs edge to edge and shows through. The stylesheet reads the
bar's height from `--drive-topbar-h` — set by `DriveShell` in `spa/drive`, and
absent by design in the playground, where it falls back to zero — to keep the
unfolded surface's panels out from under the glass. Take that variable away and
an agent's chip row ends up behind a bar you cannot click through.

## How the work is divided

|                                                                      |                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| `types.ts`                                                           | the data contract and the scene contract           |
| `layout.ts` `box.ts` `metrics.ts`                                    | pure geometry — data in, positions out, no DOM     |
| `palette.ts` `kinds.ts`                                              | the two colour axes, each single-sourced           |
| `live.ts`                                                            | what counts as a session in flight — see _Working_ |
| `knowledge-map.tsx` `map-node.tsx` `map-glyphs.tsx` `core-field.tsx` | React: what exists                                 |
| `use-map-motion.ts` `use-map-camera.ts`                              | where it is: one rAF loop, refs, no state          |

`*.test.ts` sits beside the pure modules and runs under `bun test`. Only what a
host or a test needs is exported; everything else is module-private, and there
is no `as` in the module's production code.

## React owns what exists; refs own where it is

Node positions and the camera are written straight onto `transform` attributes
from a single `requestAnimationFrame` loop. They never pass through state. Sixty
nodes tweening at 60 Hz through React would be thousands of renders a second;
through refs it is zero, and React re-renders only when the _scene_ changes.

Three rules follow from that, and breaking any of them is a performance bug:

1. **Hover is not part of the scene.** It changes on every pointer move and
   drives one class name. While it lived in the same state object the layout was
   rebuilt to light up a caption.
2. **`MapNodeView` is memoised, so its props must be stable.** `ctx` is a
   `useMemo`, the callbacks are `useCallback`, and ref callbacks come from
   `useRefRegistry` rather than being written inline. An inline `ref={el => …}`
   is a new function every render, which detaches every ref and defeats the memo
   above it.
3. **The loop skips writes it has already made, keyed on the element.** Not on
   whether the position changed — that is a different question, and getting it
   wrong is subtle: a node born at its own target never moves, and an element
   React has just re-created has no transform but has not moved either, so both
   get skipped forever. `WeakMap<Element, string>` makes a fresh element always
   get written.

The loop parks when nothing is moving, so **everything that can start it moving
again has to wake it.** There are three: a new scene, a tab coming back to the
foreground, and a new camera target. `useMapCamera` takes the wake function as a
required argument rather than being trusted to remember, because a solve nobody
draws is the worst kind of camera bug — the numbers are right, the picture is
not, and nothing in the code looks wrong.

Whether it is parked is also said out loud, on `body[data-knowledge-map-settled]`.
`onSettled` answers "has it arrived yet" once, which is what a caller waiting for
the opening tween wants; an observer outside the page needs "is it moving _now_",
because a resize re-aims the camera and settles it again. Without that, the only
question left to ask is whether two readings a beat apart agree — and agreement
cannot tell a surface that has settled from one that has not started, so it
certifies the previous viewport's framing and reports the result as geometry.

Animation is an enhancement, never the thing that makes the map correct. A
throttled or backgrounded tab gets no frames at all, so a watchdog draws one
instant frame if none has arrived in 250 ms, and `visibilitychange` lands the
layout before resuming. The same rule governs the unfolded surface: its entrance
is CSS and moves nothing but `transform`, because a panel caught mid-fade when
the frames stop is a panel you cannot read.

## Colour

Two questions get asked of every node. They are different questions, so they are
answered from different parts of the spectrum and never mix.

**Kind** — jobs iris, skills jade, files sand, apps steel. Low chroma, and only
ever a mark, a hairline or a small wash. The ring only ever shows one of the
four, and the warm points inside the core show the rest. It used to colour a row
of tabs inside an agent as well; that row is a strip of app selectors now and its
marks are keyed on whether the list behind them has _answered_, not on what kind
of thing it holds — so `kinds.ts` has one consumer left, the core field.

**State** is the only thing allowed to be saturated, and only two are: _needs
you_ (coral, solid, pulsing) and _running_ (electric blue). On a clock is a
muted dot. Finished and connected wear nothing; decorating the normal case is
how a map turns into a dashboard.

There is deliberately no tone for _unread_. It was tried: the reserved one
resolved to the same grey as a connected app, and the map's own rule forbids a
third saturated colour. Unread is told apart by **shape** instead — see
_Working_.

The two states are a warm and a cool on purpose. Running was amber, which is
coral's neighbour: an alarm and a progress light, a few pixels apart on the same
plate, that a reader had to compare to tell apart. They are now as far apart as
this palette goes, and the cool one is the colour of the only thing on the map
that moves — see _Working_ below.

Hover, focus and selection are colourless. One amber used to mean _running_,
_skills_, _you are pointing at it_, _this is focused_ and _primary button_ at
once, so it meant none of them.

Neutral surfaces are the product's own OKLCH tokens, so the map moves when the
theme does. Only the two colour axes are the map's own, and only those are
restated under `.dark`. Icons are Phosphor, the same components the nav uses;
radii follow the repo canon (`metrics.ts` `RADIUS`), and avatars use the
product's 28% corner and its generator.

**Artwork is the one exception, and it belongs to the app or agent rather than
to the map.** An app or agent that ships an icon of its own is drawn as that
icon, full-bleed on its tile, however saturated it is — it is somebody's
identity for their own thing, and a map that washed it in steel would be
recolouring what it is trying to show. An agent with none wears the generated
face instead — see `AgentFace` in `map-glyphs.tsx`. The kind colour survives
where it is the map's to give: the wash under an app with no icon of its own,
and the hairline around every one of them.

## Working

_Is this agent doing something right now_ is a **third** question, and it is the
only one still answered on the face itself. A working agent wears a rim that
pulses and a flare that arrives when the comet on its trunk does; nothing else
about its work is drawn there.

It used to also wear an attention badge — the most urgent state among its jobs,
rolled up onto its portrait. That went when the jobs became nodes of their own:
the same fact in the one place with no room to say which job it is about, and
past seven agents a coloured dot on somebody's face with no glyph and no count.
Liveness stayed because the row cannot answer it at a glance — attention
(`palette.ts`) surfaces a single most-urgent state, so an agent stuck on a
question would say nothing at all about the two sessions running underneath it.
Liveness (`live.ts`) is true _alongside_ every other state rather than instead
of one. An owner's own conversation is kept off the Jobs seat because clicking
the face opens that conversation directly, but it still counts as work in flight
for the rim and peek; presentation placement must not erase activity.

**Unread is a fourth question, and it is answered on the Jobs seat.** Not on the
face, for the same reason attention left it. It is a numeral in full ink in the
seat's opposite corner from the state roll-up, because an agent can be asking
_and_ holding work nobody has read — two questions that can both be live, and
one mark answering both would answer neither. `unreadCount` and
`UNREAD_MAX_SHOWN` in `palette.ts` own it; the numeral caps at nine, far below
the per-owner fetch bound, so a number shown here is always exact rather than a
floor.

The flare is also the only thing an agent paints outside its own tile, which is
why `inkRadius` reserves `FLARE_REACH` past the plate — see the warning on that
constant before changing either half.

**In flight is not `state === 'running'`.** A job asleep on a clock is running on
the wire and doing nothing whatsoever to a reader, so `jobIsLive` excludes it —
the same split `job-groups.ts` makes for its headings, and it reads it from here
so a face on the ring and a heading inside it can never disagree.

It is drawn as one beat crossing the map, in cause-and-effect order: a comet
leaves the core, the trunk it runs down is tinted so the line still reads between
beats, and the plate at the far end throws off a ring **as the comet reaches it**
— not as it departs, which is two animations playing at once rather than one
thing happening to something else. A second, smaller comet follows a fifth of a
cycle behind, and strikes its own ring on arrival: one pulse a cycle is a tick,
one with something following it has a rhythm.

The comet is a _dash pattern_ — a head with fragments trailing it — on a single
path, declared in fractions of its own line via `pathLength={1}`, so it crosses
in the same time at every fleet size and no stylesheet is ever told how long a
trunk is. Read the array smallest-first: the pattern travels head-last, so the
piece with the largest offset is the one furthest along the wire.

**No two agents share a clock.** `beatOf` hashes the agent's name into a phase
and a stretch, handed to CSS as custom properties, so every trunk starts
somewhere different _and_ runs a cycle slightly its own — pulses cross the map in
an order that never quite repeats, which is what a room full of independent
workers looks like. From the name rather than a counter or a clock, because the
ring re-renders on every hover and a beat that moved with the fleet would restart
every pulse on screen. The lead comet, its echo and the rings they strike all
read the same two properties, so a beat stays a beat while the ring drifts.

Pointing at a working face opens a **peek** (`live-peek.tsx`): what is running,
which step it is on, and what is waiting behind it. It is HTML beside the canvas
rather than inside it — the camera scales what is inside, and the frame clips it
exactly where the ring runs closest to the edge — and it follows the face off
`getScreenCTM` for the same reason node positions are a ref rather than state. It
never takes the pointer: everything in it is one click away in the agent's own
surface, which is what it is a peek at rather than a replacement for.

Reduced motion gets the tinted wire and the rim standing still; the spark and the
ping come off entirely, because a pulse with a stopped clock is a stub of light
parked at one end of a line.

## Where a fan sits

An agent's apps sit on the **tangent** at the fan radius rather than on the arc
through it. On the arc they land on slightly different baselines whenever the
agent is near the top or the bottom of the ring, and captions on four baselines
read as misalignment rather than as radial layout. The old fix slid each chip
along its own radius until they lined up, which needed a bound, a direction rule
and a second number in the node for the caption to follow. A straight line needs
none of them.

The row is flipped where it has to be so it always reads first-to-last left to
right, and top to bottom on the two flanks where it is a column.

Duet's own apps are the exception, because a tangent needs an outside to hang
off and the core's outside is the ring itself. They take slots on the ring the
way the add slot does — one each, so the arc that keeps two agents apart keeps
them apart too, and the collision invariant below covers them for free.

The add slot is **one** seat, and the two ways to fill it — hiring an agent
that exists, writing one that does not — are asked for after the click rather
than drawn. It used to be two nodes, the second hanging off the first on a
dashed limb at an app seat's radius. They read as one choice, which is the
argument for asking it once: the satellite spent arc, a second caption and, at
one agent where the ring is a line, the scene's whole long axis, all to
pre-empt a question the dialog can put two squares to.

## The ring has two budgets, and only one of them has room

**Arc** is the circumference between neighbouring agents, spent by anything drawn
sideways. **Radius** is how far out the drawing reaches, and the camera fits the
union of every box into the container's _short_ axis — so radius is the axis the
camera pays for, and the ring's radius already grows linearly with the head count
because every agent claims a fixed slice of arc.

That is why the density ladder exists and why it has three rungs rather than one
threshold. Past seven agents the secondary captions go (`dense`); past fifteen
the app fans go too and the arc they needed comes back (`crowded`), because
without that a twenty-agent drive draws its faces at 33px and its captions below
the map's own `TEXT_FLOOR`. All three rungs are solved in `ring()` and read off
the `Ring` record — one owner for how crowded the map is, rather than a headcount
re-tested at each call site.

The same reasoning governs the second row. Its pitch is **solved from the arc
actually available** at that radius, not pinned, and whether a job draws its
title is one predicate over that pitch: can this room hold at least nine
characters? Below that the row draws dots. Nobody chose the fleet size where it
flips — it falls out at seven agents, which is where the map already stops naming
apps.

## Two invariants the tests hold

**The camera frames content; it is never a magic number.** Every node declares
the box it paints into via `size()`, and the camera fits the union. Add a kind
and forget its box and the camera clips it — which is why `MapNode` is a
discriminated union and `size()` switches exhaustively.

That union is also the camera's own trigger. A solve is a function of three
things — the box it framed, the shape of the surface, and where on that surface
the framing asked for it — and only two of those move by somebody's hand. The
third moves underneath it: a scene arrives with more in it than the last one and
the standing solve is silently too close. So `useMapCamera` re-solves whenever
the box it framed moves, and on nothing else — a scene that redraws the same
picture is not a change, or a clock ticking once a minute would re-aim a camera
somebody is watching. The host used to watch the agent count instead, which is
one of the three reads home is drawn from; `framing.test.ts` walks the load wave
by wave and asserts the picture is inside the frame at every one of them.

**No two ring bodies touch, at any fleet size, with every agent carrying a full
fan.** `layout.test.ts` asserts it against `discRadius`, not `size` — the framing
box reserves label space that is often empty, so measuring collisions with it
flags every diagonally separated pair. That test is what justifies the ring's
minimum radius.

⚠️ The test is only as honest as `discRadius` is. A kind whose declared radius is
smaller than what it paints passes the check while overlapping its neighbours by
the difference, and nothing goes red — which is exactly what happened when the
Jobs seat kept a radius of its own while drawing at the app seat's. Every seat in
the row now answers `M.APP_R`, in one branch of the switch, so the three cannot
drift apart again.
