# Waiting

One navigation, one skeleton. That is the whole rule, and everything in this
folder exists to keep it true.

A reader who clicks a thing should see the shape of that thing, once, and then
the thing. Not the shape of somewhere else first. Not a blank page between the
shape and the content. Not one skeleton replaced by a differently-shaped
skeleton because a second component further down also had an opinion about
waiting.

## The three rules

**1. A page-level wait is chosen by the browser location, in one place.**
`loading-route.ts` maps a pathname and its presentation query to the destination
that owns its skeleton, and every surface that can draw a full-screen wait —
the server's streamed shell, the bootstrap island, the lazy-chunk fallback, the
route's own not-ready-yet branch — resolves through it. Four callers, one
answer, so they cannot disagree about what the reader is waiting for.

**2. An unknown path is not a destination.**
The island used to default its path to `''`, which walked out of
`loadingViewForPath` as the map — so any wait whose location had not been
threaded through drew *the whole drive's picture* and then threw it away. Bare
workspace paths resolve to Work Home, and session paths select Work directly.
App paths carry an explicit Work presentation query because they also address
Build apps. Under an 8×
CPU throttle a cold load of an agent showed a map island for 400ms and then the
agent's page skeleton: two full-screen skeletons for one navigation, the first a
picture of somewhere the reader was not going. A caller that does not know the
path asks the browser for it; nobody guesses, and no guess resolves to a
specific destination.

**3. A page holds its own skeleton until it can draw content.**
Not until *some* of its data lands — until the page can draw. The agent's page
learned this twice: it drew nothing at all while a bare URL was being rewritten
to the card it opens on (deliberately, so a cold link cannot paint one
destination and jump to another) — and "nothing" is a blank page, measured at
1.4s of empty screen between the skeleton and the card. The withholding was
right; rendering nothing during it was not. See `drawable` in
`routes/agent-route.tsx`.

## Every wait says so, in one attribute

`data-loading-view` is on all of them, named for the destination that owns it in
`loading-route.ts`. That is what makes "is this reader waiting on a page right
now" a question anything can ask — a test, a gate, the next person wondering
whether a change removed a wait or merely moved it. One attribute and no
second marker: a skeleton found by its class name or its `role` is found by a
selector that goes stale the first time somebody restyles it, and a wait with
two markers is a wait that can answer the question two ways.

Reading it takes one care: a wait that is *on screen* is not the same as one in
the DOM. The map's shape stays mounted while it dissolves into the ring that
replaced it, so anything counting waits has to ask the browser what is
visible — opacity included — rather than what exists.

## The best skeleton is the one nobody sees

None of the above says a wait is inevitable, and most of them are not. A read
this browser has already paid for is kept and restored on the next load, so the
second visit to a surface draws it rather than its shape — see **Server-state
cache** in the app's [README](../../README.md). What is left for this folder is
the genuinely first time, which is the only time a skeleton is honest.

## What is not a second skeleton

A region inside a page that has already drawn — the app frame waiting on
somebody else's document, the drive listing its folder — may show a placeholder
of its own. The reader is not waiting for the page then; they are looking at it,
with one part of it still filling in. `AppFramePlaceholder` and `DriveSkeleton`
are that, and they are fine.

The line is whether the page is drawn. A placeholder that occupies the whole
window is a page-level skeleton no matter which component rendered it, and rule
1 applies to it.

## Making a page's skeleton worth having

It should be the page's own shape, so what replaces it is this composition with
content in it rather than a different picture — `HomeLoadingIsland` solves the
map's real layout to place its plates, and `AgentPageSkeleton` borrows the
surface's own `.km-sheet` classes so its bars stand exactly where the real
columns will. Work follows the same rule: `WorkBootstrapShell` reserves the
17rem desktop rail or compact mobile chrome, while `WorkLoadingIsland` changes
only the destination pane. Both under-draw rather than over-draw: no bar for an
agent's slug, because plenty have none; nothing in the card's stage, because
what opens there is the reader's own arrangement. Under-drawing resolves into
the truth. Over-drawing has to be taken away again, and that reads as a fault.
