# Mobile evidence pack (measured, not guessed)

Source: `apps/web`, branch `claude-work/agent-view-qa-chat-7f3056`.
Method: the real shell fixture (`/playground/spa-shell`) driven through 29 product
routes at 390x844 and 320x844, measuring live element geometry; plus the 496
committed mobile baselines in `apps/web/tests/visual/__screenshots__/mobile/`.

## The load-bearing fact

`apps/web/spa/knowledge-map/knowledge-map.css:1433` — the agent surface (`.km-sheet`)
is a two-column grid with a *container* query, and the code states the phone case is
an explicit non-goal:

> "This is a desktop surface and a phone is not a shape it is designed for; it is a
> shape it must not be *broken* in."  (line ~1425)

> "The phone fallback keeps the desktop composition side by side, which makes the
> card itself about 190px wide."  (line ~2087)

Measured at 390px viewport: `.km-sheet` children are **170px and 190px**.
At 320px: **138px and 152px**.

## Measured defects, by surface

### Agent surface — `/w/:ws/agents/:slug` and every tail under it
| what | measured |
|---|---|
| chat column / work card | 170px / 190px @390; 138px / 152px @320 |
| "Back to all agents" (`.km-leave`) | 26x26 |
| Train / Settings / Jobs (`.km-act`) | 66x28, 85x28, 65x28 |
| Files / Desktop pickers (`.km-pick`) | 48x25, 68x25 |
| "Archive default chat" (`.km-chat-act`) | 149x17 |
| compose-bar quality label | ink 53px in an 8px box (15%) |
| a job question title ("Rollout owners") | ink 100px in a 4px box (4%) |
| "Attach files" | 32x32 |

Train, Settings and Jobs have **no other door in the product**. On a phone they exist
only as 28px-tall links inside the crushed 170px column.

### Session dialog — `/w/:ws/agents/:slug/sessions/:id` (full-screen `lg:hidden`)
| what | measured |
|---|---|
| ~~a pane pushed past the window~~ | *retracted: the 549px overhang is the decorative `siri-orb-smooth` layer, clipped by an `overflow-hidden` parent. Not a defect.* |
| session title | ink 236px in a 62px box (26%) @390; 1px box @320 |
| "Back to the jobs" | 22x22 |
| "View token usage" | 14x14 |
| Reasoning / bash / read_file disclosures (`summary`) | 20px tall |
| answer checkboxes | 16x16 |
| Submit | 61x28 |
| dialog Close | 16x16 |

### Knowledge map (workspace home) — `/w/:ws/agents`
App nodes are 46x29, 64x29, 38x29 tap targets; node labels render at ~4px and are
unreadable at phone width. No pinch-zoom affordance.

### Integrations — `/w/:ws/integrations`
Per-connection action clusters go side-by-side at 76–96px each; agent-access
checkboxes are 20x20; Connect/Disconnect/Reconnect are 32px tall.

### Settings
- `/settings/api-keys` — scope strings truncated to 25–54% of their ink. The scopes a
  key carries are the point of the row and are unreadable on a phone.
- `/w/:ws/settings/usage` — meter rows and ledger rows squeeze to 45px columns.
- `/w/:ws/settings/publishes` — freeze toggles 44x24.
- `/w/:ws/settings/general` — "Save changes" shares a row with a 65px label.

### Train — `/w/:ws/train/:agentSlug`
Job rows squeeze to 55–85px right columns at 320.

### Touch behaviour, product-wide
- `touch-action` is declared **once** in the whole app (`knowledge-map.css:411`, the
  canvas). The draggable app-chip row (`.km-pick-slot`, `draggable`) sits inside a
  horizontally scrolling strip with no touch-action policy and a
  `PointerSensor {distance: 4}` — a touch drag and a touch scroll compete.
- No `-webkit-tap-highlight-color` policy anywhere.
- Radix `Tooltip` is the only label on icon-only controls in
  `spa/files/drive-toolbar.tsx`, `spa/apps/app-actions.tsx`,
  `spa/files/preview-pane.tsx`. Tooltips do not open on touch.

### Affordances that only exist under a pointer
| file | what disappears |
|---|---|
| `spa/sessions/session-message.tsx:254` | a stacked message's timestamp — never visible on touch |
| `spa/sessions/session-controls.tsx:93` | the rename pencil on the session title |
| `spa/routes/agents-map/agent-surface/parts.tsx:658` | the "opens" arrow on a row |
| `packages/ui/src/components/common/inline-edit-text.tsx:208` | the edit control |
| (good counter-example) `spa/files/files-surface.tsx:870` | `opacity-100 md:opacity-0 md:group-hover:opacity-100` — the pattern to copy |

## What is already right (do not regress it)
- `app/layout.tsx:63` — `viewportFit: 'cover'`, `interactiveWidget: 'resizes-content'`.
- Safe-area insets are respected in the sheets that have them (share dialog, relay
  status, turn usage, agents rail, onboarding footer).
- The session viewer is already a full-screen `h-dvh` dialog under `lg`.
- Drive, marketplace, onboarding, auth and the publish viewer read well at 390.
- No page-level horizontal scroll on any route at 390 or 320.

## Stale artefacts found
`spa-shell-mobile-more.png`, `sessions-search.png`, `sessions-list.png` are committed
mobile baselines for a bottom-tab-bar + "More" drawer navigation that no longer
exists in the code (baselines dated 2026-07-11/07-22; the live shell's are 2026-08-18).
Mobile once had a dedicated navigation drawer and it was removed.

## Three structural facts found during the debates, and verified against source

### 1. The map's legibility floor is measured in the wrong unit
`spa/knowledge-map/metrics.ts:206` declares `TEXT_FLOOR = 11` — "no word on the map is
ever drawn smaller than this, **in screen pixels**". `labelScale(cam)` (`:222`) enforces
it as `TEXT_FLOOR / (TYPE.t4 * cam)` — against the camera scale alone, in **world**
units.

`layout.ts:67` `viewport()` pins the **short** axis of the viewBox to `VIEW = 1048`.
So one world unit is worth `min(containerW, containerH) / VIEW` CSS pixels:
- 1440x900 landscape: 900/1048 = **0.859** → an "11px" floor paints at 9.4px
- 390x844 portrait: 390/1048 = **0.372** → it paints at **4.1px**

4.1px is exactly what the phone baselines show. The invariant has never held; the phone
is where it stopped being survivable.

`use-map-motion.ts:391-394` states the same rule and gets it backwards for portrait:
> "The viewBox is `VIEW` on its short side whatever shape the map is, so a world unit
> is worth `height / VIEW` pixels and the width cancels."

The width cancels only in landscape. `--km-screen` therefore overstates the drawn size
by `height / width` = **2.16x** at 390x844.

`spa/knowledge-map/type-scale.test.ts:50` — the assertion that would have caught this
exists, but its narrowest surface is `viewport(468, 804)`. It has no portrait case.

### 2. The visual gate cannot see touch
`apps/web/playwright.config.ts` — the `mobile` project is
`{...devices['Desktop Chrome'], viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true}`.
It sets `isMobile` but **not `hasTouch`**, so `(pointer: coarse)` and `(hover: none)`
do not match. Every touch-conditional branch in the product is invisible to all 496
mobile baselines. Any fix written behind a coarse-pointer query would ship unphotographed.

### 3. A mobile viewport system was built, then removed, leaving its tokens behind
`packages/tailwind-config/globals.css` declares `--app-shell-safe-area-top` (:81),
`--visual-viewport-bottom-inset` (:102), `--app-shell-height` (:113) and
`--app-shell-safe-bottom` (:136), each with a comment naming its intended consumer.
**None of the four has a single consumer anywhere in the repo**, and the writer the
comments name (`use-mobile-viewport-vars.ts`) does not exist. Nothing reads
`window.visualViewport` anywhere in the product.

## A correction to this pack's own method

The geometry sweep that produced the tables above read `getBoundingClientRect()` directly.
That rect reports where an element *would* be and keeps reporting it after the element has
scrolled out of the box that clips it — so a disclosure row scrolled off the top of a
conversation still answers with a position up under the identity block above it.

Four of the six "crossing hit areas" first reported by `touch-targets.spec.ts` were that
artefact, not defects. The suite now intersects every rect with each clipping ancestor on
the way up and drops what is left over when the remainder is empty. The two that survive
are real.

The same correction retires a workaround: the suite briefly excused any crossing between
the floating top bar and the route sliding under it. With rects clipped properly, that
exemption turned out to be dead — every scroller that runs under the bar also carries
`DRIVE_TOPBAR_CLEARANCE`, so no control ever comes to rest beneath it. The exemption is
gone, which makes the assertion stronger: remove the clearance and a stranded control now
shows up as one.
