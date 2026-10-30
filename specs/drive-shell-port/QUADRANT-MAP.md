# Quadrant map — Miller-column Drive port (slices 05+06 + document takeover)

Walked 2026-08-04. The map is the deliverable; it records what is settled, what
was decided during the walk and why, and what is still open. A builder picking
this up should not have to re-decide anything below.

## 1 — Known knowns

The request: revive the macOS Miller-column drive from
`chat-app@1004a60da5191a9d3e8fb286ec5f523e494d4953` (refined through
`bc9078fa9`) into duet-cloud's Drive **and** the agent card's Files tab. Spec
slices 05+06. The card grid is replaced, not kept behind a toggle. Documents
open as a takeover of the drive region, not a lightbox.

Landed and verified:

| Fact | Owner |
| --- | --- |
| Columns, drilling, trail highlight, both scroll behaviours, depth fades | `apps/web/spa/files/drive-columns.tsx` |
| Open chain derived from `path`, never stored | `apps/web/spa/files/column-chain.ts` |
| Keyboard traversal as a pure reducer (8 tests) | `apps/web/spa/files/column-keys.ts` |
| Filter/sort/density, incl. Duet-only truthful size sort | `apps/web/spa/files/column-rows.ts` |
| Control strip + breadcrumb | `apps/web/spa/files/drive-toolbar.tsx` |
| Row presentation, density metrics, trail vs selected | `apps/web/spa/files/drive-column.tsx` |
| One query per open folder, reusing the drive's own cache keys | `apps/web/spa/files/drive-columns-data.ts` |
| Symlinks stay opaque, `target` preserved | `apps/web/spa/files/lib/types.ts` |
| Document takeover replacing the lightbox | `apps/web/spa/files/files-surface.tsx` |
| Both mounts assembled once | `apps/web/spa/files/workspace-drive.tsx` |

Green at the time of writing: 915 SPA unit tests, `check-types`, `lint`,
visual-coverage ledger, owner union, and two approved `playground/files`
baselines.

### Settled assumptions

1. The public publish viewer keeps the card grid (`DriveBrowser`). It is a
   separate read-only product surface and is out of scope.
2. The takeover replaces the control strip as well as the columns — the
   toolbar sorts and filters a listing, and there is no listing while a
   document is open.
3. Row density is a Drive-local control; there is no app-global density
   setting.

## 2 — Known unknowns, all closed

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| 1 | What replaces the `[data-files-preview]` contract the lightbox owned? | Emit `data-files-preview` on the takeover region itself. | "A document is open" is still a true claim; only its presentation changed. Closed by the territory: `staging-e2e-synthetic:408-429` needs no dialog semantics — it waits on `data-files-path`, then the marker, then a heading with the filename and a `textarea` with the content, all of which `PreviewPane` already renders. Zero journey edits. |
| 2 | Does the takeover keep Escape-to-close? | Yes — Escape runs the same handler as Back. | Preserves a gesture learned from the lightbox and keeps the existing visual assertion working. Escape-as-back is defensible without a modal. |
| 3 | Does a document take over the agent card's region too? | Yes — identical in both mounts. | One drive, one rule. The card keeps its agent chrome and selectors around the swapped region, so the reader loses the file list, never the agent. Nothing forks. |

## 3 — Unknown knowns (tacit context, now explicit)

Taste and constraints that were never written down for this task but govern it:

- **Confined over modal.** The lightbox was rejected on sight. Surfaces
  belong inside the region that owns them; a dialog that dims what it covers
  while the address bar insists you are still there is the failure mode.
- **Replace, do not toggle.** Compatibility branches and "classic" modes are
  not wanted; the superseded thing is deleted.
- **The feel is the spec.** What was being asked for is the *behaviour* —
  auto-scroll on drill, the persistent trail — not literal visual parity with
  the reference.
- **Selector contracts are load-bearing.** `data-files-card`,
  `data-files-preview`, and `data-files-path` are read by the staging harness
  against real infrastructure. Renaming one is a contract change, not a
  refactor.
- **Design system** (see the project memory): radius canon
  (controls `rounded-md`, rows `rounded-lg`, panels `rounded-xl`), serif
  reserved for page-level titles, the `Skeleton` primitive over raw
  `animate-pulse`, user-facing noun is **Drive** while code identifiers stay
  `files*`.
- **One owner per concept**, and comments that explain *why* rather than
  restate the code.

## 4 — Unknown unknowns (landmine sweep)

Found by sweeping rather than by being asked. The first two are live defects
in what has already landed.

1. **The footer describes a folder that is no longer on screen.** It renders
   `9 items · 4.4 KB` beneath an open document, because it sits outside the
   swapped region. Either scope it to the document or hide it during takeover.
2. **The drag-and-drop upload zone now sits under the open document.** Upload
   is bound to the `<section>` the takeover renders into, so dropping a file
   onto a document silently uploads it to the parent folder.
3. **`getByLabel('Clear search')` has no match** — the clear button is
   labelled `cancel`. This is the flow test's failure at
   `playground.spec.ts:4193`, and a missing i18n key, not a design problem.
4. **The preview stall is unconfirmed.** `preview-pane.tsx:235` returns the
   skeleton whenever the snapshot is null with no error. The same read path is
   exercised green by the pre-existing lightbox test, so this may have been a
   2-second screenshot race. **OPEN** — unblocked by one run against a fresh
   dev server.
5. **Mobile takeover is unverified** at 390px. The columns' mobile layout was
   fixed and approved; the takeover was not captured on mobile.
6. **Two baselines will move**: `files-search.png` and
   `files-markdown-preview.png`.
7. **The large flow test** (`playground.spec.ts:4146`, ~450 lines, ~55
   interactions) was written against the deleted card grid and needs a
   deliberate pass. Docker iterations are ~2 min each.
8. `apps/web/spa/routes/agents-map/agent-drive.test.tsx` asserts the surface
   still renders `data-files-surface` — unaffected, confirmed still true.

## Build order implied by the map

1. Move `data-files-preview` onto the takeover; wire Escape to Back.
2. Fix the footer and the drop zone during takeover (landmines 1 and 2).
3. Add the `Clear search` label in both locales.
4. Confirm or kill the preview stall on a fresh dev server.
5. Re-point the flow test; capture mobile takeover; re-approve baselines.
6. Run the `drive-deep-links` staging journey as the closeout gate.

---

## Round-two feedback (2026-08-04, after first look at the columns)

### Done

- **Columns fill the height they are given.** Root cause was not the columns:
  `LoadingHandoff` wraps children in a plain block `motion.div`, so
  `DriveColumnsBrowser`'s `flex-1` root had no flex parent to resolve against and
  collapsed to content height. Both it and `DriveColumn` now take `h-full
  min-h-0`.

### The skeleton principle (governs everything below)

> Show a skeleton **only** for what is genuinely being fetched for the first
> time. Everything already cached keeps rendering while it revalidates.

Three places currently violate it.

**1. Navigating into a folder blanks the whole surface.**
`FilesSurface` gates on `LoadingHandoff loading={viewQuery.isPending}`, which
covers the entire region. Walking into `/a/b` makes that query pending, so the
full `DriveSkeleton` draws even though `/` and `/a` are cached and on screen.

The fix is not to soften the skeleton — it is that **the chain must be derived
optimistically from `path`, not from the resolved view.** Then `/a/b` appears
immediately as a new column in `loading` state while its ancestors keep
rendering from cache, which is exactly the asked-for behaviour.

One wrinkle, and it is solvable: if `path` names a *file*, an optimistic chain
would append a bogus column for it. That is knowable without a round trip —
the parent column is already cached, so its entries say whether the last
segment is a directory. Resolve against the cache, not against the network.

The surface-level `LoadingHandoff` should then fire only on a true cold start
(nothing cached anywhere), not on every navigation.

**2. Opening a file blanks everything, including facts already known.**
The name, kind, and size are all in hand from the listing before the fetch
starts. `PreviewPane` should render its header from `entry` immediately and
skeleton only the content region — the one thing actually in flight. Today it
returns a whole-pane skeleton from `preview-pane.tsx:240` until the snapshot
lands.

Note this is adjacent to, but not the same as, the **open stall** — where the
snapshot never arrives at all. Fixing the skeleton scoping will make the stall
*more* visible, not less: the header will render and the content will sit
empty.

**3. Preview header composition.**

- Remove the live/reconnecting status pill — it is not carrying its weight.
- Put **file size** in its place; it is the more useful fact, and it comes
  from `entry.size` so it can render before the fetch resolves.
- Move **seen-by** into the header.
- The content region takes the full height available.

### Build order

1. Optimistic chain from `path`, resolved against cached parent entries.
2. Cold-start-only surface skeleton.
3. `PreviewPane` header-from-entry, content-only skeleton, full-height content.
4. Header composition: drop live, add size, fold in seen-by.
5. Then the open stall, which step 3 will have isolated to the content region.

---

## Correction: there was never a preview stall

Recorded here because it was asserted as a confirmed product bug twice and it
was not one.

`LiveFileController.start()` (`use-live-file.ts:115`) deliberately defers the
first load while the tab is hidden:

```js
this.visible = this.runtime.isVisible()   // document.visibilityState === 'visible'
if (!this.visible) return                 // nothing loads until the tab is shown
```

The automated browser pane used for verification reports
`visibilityState: 'hidden'`, so the content never loaded **in that environment
only**. Playwright reports visible, which is why the committed baselines were
always green. Forcing `visibilityState = 'visible'` and dispatching
`visibilitychange` renders the document immediately.

The lesson is about the harness, not the product: a verification surface that
reports itself hidden cannot exercise any visibility-gated code path, and
"it never resolved" in that surface is not evidence of a hang.
