# Duet on a phone

**What this is.** An audit of every product surface at phone widths, five adversarial
debates on the decisions that could not be settled by measurement alone, and the plan
that came out of them.

**The one-sentence finding.** Duet is *responsive* — nothing overflows, no route scrolls
sideways — and it is not *usable*: the flagship surface renders its desktop composition
into a 390px window, three destinations have no door a thumb can hit, and the gate that
was supposed to catch this has been photographing a mouse for 496 screenshots.

The measurements behind every claim here are in [EVIDENCE.md](EVIDENCE.md).

---

## 1. How this was measured

Two independent passes, deliberately different in kind:

| pass | what it is | what it is good at |
|---|---|---|
| **Geometry sweep** | the real shell fixture (`/playground/spa-shell`) driven through 29 product routes at 390×844 and 320×844, reading live element boxes | crushed text, offscreen content, undersized targets — things an eye rationalises away |
| **Baseline review** | the 496 committed mobile PNGs, read as contact sheets | composition, hierarchy, what a person actually sees |

Neither is sufficient alone. The sweep found a job-question title rendering its 100px of
ink into a 4px box — invisible in a screenshot, because there is nothing there to see.
The baseline review found that the agent card is two columns on a phone — invisible to
the sweep, because two 170px columns overflow nothing.

One claim from the sweep was **retracted** on inspection: a 549px overhang in the session
dialog is the decorative `siri-orb-smooth` layer, clipped by its parent. Not a defect.

---

## 2. What is already right

This is not a neglected codebase, and the plan below is smaller because of it.

- `app/layout.tsx:63` — `viewportFit: 'cover'`, `interactiveWidget: 'resizes-content'`.
- Safe-area insets are handled in every sheet that has one.
- The session viewer is already a full-screen `h-dvh` page under `lg`.
- The agent-jobs pane already does master/detail one-at-a-time under `md`.
- Drive, marketplace, onboarding, auth and the publish viewer read well at 390.
- `files-surface.tsx:870` carries the correct hover pattern — `opacity-100 md:opacity-0
  md:group-hover:opacity-100` — visible on touch, revealed on hover. It is the template.
- No page-level horizontal scroll on any route, at either width.

---

## 3. The inventory

Severity is about what a person cannot do, not about how it looks.

### P0 — functionality a phone cannot reach

| # | finding | where |
|---|---|---|
| **1** | **The agent card renders its desktop two-column composition on a phone**: a 170px conversation beside a 190px work card (138/152 at 320). Every tail under `/agents/:slug` inherits it. | `knowledge-map.css:1433` |
| **2** | **Train, Settings and Jobs have no other door in the product.** On a phone they exist only as 28px-tall links inside that 170px column. | `agent-surface/parts.tsx:125-147` |
| **3** | **The map's legibility floor is measured in the wrong unit.** `TEXT_FLOOR = 11` is declared "in screen pixels" and enforced in world units. At 390px one world unit is 0.372 CSS px, so the floor paints at **4.1px**. The invariant has never held on any device; the phone is where it stopped being survivable. | `metrics.ts:206,222` |
| **4** | **Tooltips are the only label on icon-only controls**, and tooltips do not open on touch. The Drive density toggle's own comment says so: *"two glyphs that differ by a couple of lines: the tooltip is where each one says which it is."* | `drive-toolbar.tsx:552`, `app-actions.tsx`, `preview-pane.tsx` |
| **5** | **API-key scopes truncate to 25–54% of their ink.** The scopes a key carries are the point of the row. | `/settings/api-keys` |

### P1 — reachable, but not with a thumb

Measured, not estimated. The 44px floor is the platform's, not a preference.

| control | measured | where |
|---|---|---|
| "View token usage" | **14×14** | session timeline |
| answer checkboxes, dialog close | **16×16** | job questions, `dialog.tsx:85` |
| agent-access checkboxes | **20×20** | integrations |
| Reasoning / `bash` / `read_file` disclosures | **20px tall** | session timeline |
| "Back to the jobs" | **22×22** | session dialog |
| "Back to all agents" (`.km-leave`) | **26×26** | agent card |
| Train / Settings / Jobs (`.km-act`) | **28px tall** | agent card |
| Files / Desktop (`.km-pick`) | **25px tall** | agent card |
| "Archive default chat" | **17px tall** | agent card |
| every shell control — tabs, switcher, account | **36px or less** | top bar |

### P2 — layouts that squeeze rather than restack

Two- and three-column rows holding 45–96px columns: integrations action clusters,
usage meters and ledger, publishes rows, train job rows, `settings/general`'s
"Owner / Save changes".

### P3 — affordances that only exist under a pointer

| what disappears on touch | where |
|---|---|
| a stacked message's timestamp — *never visible* | `session-message.tsx:254` |
| the rename pencil on a session title | `session-controls.tsx:93` |
| the "opens" arrow on an agent-surface row | `agent-surface/parts.tsx:658` |
| the edit control on an inline-edit field | `inline-edit-text.tsx:208` |

### P4 — touch behaviour

- `touch-action` is declared **once in the whole app** (the map canvas). The draggable
  app-chip row sits inside a horizontal scroller with a `PointerSensor {distance: 4}`
  and no touch-action policy: a drag and a scroll compete for the same gesture.
- No `-webkit-tap-highlight-color` policy anywhere.

---

## 4. Three things that were not on anyone's list

These came out of the debates and were then verified against source. Each is worse than
anything in the inventory, because each is a reason the inventory stayed invisible.

### 4.1 The visual gate cannot see touch

```
mobile project      →  { coarse: false, fine: true }
iPhone 13           →  { coarse: true,  fine: false }
```

`playwright.config.ts` builds the `mobile` project from `devices['Desktop Chrome']` with
`isMobile: true` — and never sets `hasTouch`. So `(pointer: coarse)` and `(hover: none)`
do not match, and **every touch-conditional branch in the product is invisible to all 496
mobile baselines.**

This has a sharp consequence for the plan: *a fix keyed on capability ships
unphotographed; a fix keyed on width is caught by the gate.* Where both would work, the
plan keys on width.

### 4.2 A mobile viewport system was built, then removed, leaving its tokens

`packages/tailwind-config/globals.css` declares `--app-shell-safe-area-top` (:81),
`--visual-viewport-bottom-inset` (:102), `--app-shell-height` (:113) and
`--app-shell-safe-bottom` (:136), each with a comment naming its consumer. **None has a
consumer.** The writer those comments name, `use-mobile-viewport-vars.ts`, does not exist,
and nothing in the product reads `window.visualViewport`.

`interactiveWidget: 'resizes-content'` is Chromium-only. On iOS Safari the layout viewport
does not shrink for the keyboard, so `100dvh` and `bottom: 0` sit *underneath* it. Nothing
in the repo handles this — including the share dialog's email field, which is exactly the case.

### 4.3 Mobile once had a navigation drawer, and it was deleted

`spa-shell-mobile-more.png` (2026‑07‑22) is a committed baseline for a bottom tab bar and a
"More" sheet holding Files, Train, Integrations, Workspace settings, User settings, Internal
admin, Language, Sign out. No code renders it. It is a stale artefact of a navigation that
was removed — and **Train has had no door since.**

---

## 5. The debates

Five decisions were not settleable by measurement. Each was argued by two agents given the
same evidence and opposed briefs, each required to state the strongest objection to its own
position. The rulings are mine.

---

### D1 · What does the agent card do on a phone?

> *"This is a desktop surface and a phone is not a shape it is designed for; it is a shape
> it must not be broken in."* — `knowledge-map.css:1425`

The phone case is a documented non-goal. That is the sentence this whole project exists to
change.

**A — Restack.** One column, one scroll: identity, then the work card, then the
conversation. `display: contents` on `.km-sheet-left`, the page becomes the scroller, the
card bounded at `min(72svh, 34rem)`. *Adds no state and changes no URL* — a link means the
same thing on both devices.

**B — One pane at a time.** The conversation full-width by default; the work card is a peer
view reached by a segmented switch. Panes are `display: none`, never unmounted, so scroll
positions and a live app's grant survive. The switch's second segment is **named for the
current view** — it says "Invoices", not "Work" — and carries that view's change mark.

**▸ Ruling: B, one pane at a time.**

Three reasons, in order of weight.

1. **The product already answers this question twice, the same way.** `sessions.tsx:1585`
   turns a pane into a full-screen page under `lg`. `agent-jobs/panes.tsx:162,269` does
   `picked === null ? 'grid' : 'hidden md:grid'` — master/detail, one at a time, under `md`.
   Restacking would be a third answer to a question this codebase has settled.
2. **A live app iframe inside a page scroller is a scroll trap.** A finger inside the frame
   never moves the page, and the app scrolls itself. A bounds an iframe at 72svh, which
   mitigates and does not remove: you must still find the gutter to get past it.
3. **A's objection to B on URLs does not land.** A argued a switch must either invent a path
   segment or become an unshared preference. B's answer is correct: the URL *already* names
   the card, so a URL naming an app opens on the work pane and a bare agent URL opens on
   chat. Link parity holds in both directions without new grammar.

**Not hiding — and the test is mechanical, not aesthetic.** Both segments are always drawn,
the inactive one printing the name of its own content; nothing sits behind a hamburger or a
gesture. Identity and the three doors are lifted to sheet-level furniture, on screen in
*both* panes. A change while you are away lights the other segment.

**Adopted from A:** `.km-picks { touch-action: pan-x }`, `.km-pick-slot { touch-action:
manipulation }`, and drag withheld on a coarse pointer — the concrete fix for P4. Both sides
agree the `@container (max-width: 28rem)` compaction block is deleted: its stated premise is
the 190px card, which stops existing.

---

### D2 · What does a phone see at the workspace home?

**A — Keep the canvas**, and fix why it is illegible: the floor is applied in world units
(§3 #3), so make `labelScale` read the world→pixel ratio, let the density ladder pick its
rung from predicted screen size rather than head count, and solve hit radii back from 44
CSS px.

**B — The phone gets the list.** The rail already exists and is the same records with an
order a reader can check; extract it from its beside-a-canvas chrome and give it the address.

**▸ Ruling: B — overruled in B's favour by the product owner, after the debate.**

The debate landed on A, and then Walter settled it the other way: *"on mobile we can get
rid of the map and have a beautiful list."* That is the call to make — B is a product
decision about what a phone is for, and the debate could only weigh it, not decide it. So
the phone opens on the list.

What A won on the way is kept, because it was never really about which composition wins:

A found a **bug**, not a taste question. `TEXT_FLOOR = 11` promises screen pixels and
delivers 4.1 of them; `type-scale.test.ts` has an assertion that would have caught it and no
portrait surface to catch it with. That is still real, and it is still wrong **on the
desktop too** — at 1440×900 the floor lands at 9.4px rather than 11. Dropping the map from
the phone does not fix it; it only removes the width where it became unsurvivable. It stays
on the list, at its true severity, which is lower than it looked.

**Adopted from B, and it shaped what shipped:** the rail had *never been photographed* on a
phone (§4.1), and it had no `onAddAgent` door — the add slot is a face on the canvas, so a
list without one would have made creating an agent impossible on a phone. The shipped page
carries it in the header.

**Scoped deliberately:** pan-and-pinch is a new subsystem and is not in this plan. With the
canvas off the phone entirely it is no longer needed for this work at all.

---

### D3 · Where does the phone's navigation live?

**A — One bar, at the top.** Same navigation on every device. Grow every shell control to
44px (costs 4px of window height), and make the account menu a bottom sheet on touch,
carrying Train and the settings surfaces.

**B — A bottom bar on phones.** Destinations move under the thumb; the top bar keeps
identity. The bar hides when a composer takes focus.

**▸ Ruling: A.**

B's own mitigation defeats it. The bottom bar must disappear whenever a composer is focused
— and on the agent surface the composer *is* the control. A bar that is absent for most of
the time a phone user spends in the product's main surface is not navigation. It also spends
~90px on the shortest axis of the smallest screen.

A's structural argument stands: a bottom bar **forks the information architecture** — phone
gets four tabs plus More, desktop gets three — and `workspace-tabs.ts` already documents that
exact divergence hazard for `desktop`. Every future destination would have to be placed twice
and could disagree with itself.

A is also honest about what it does not answer: a top bar on a 6.7" phone is the hardest
place to reach, and A does not pretend otherwise. It buys the argument on frequency — section
switching happens at task boundaries, and everything touched continuously is already in the
reachable third.

**What this restores:** the retired drawer's *contents*, not its bar. The account sheet
carries Train — the door that has been missing since §4.3.

---

### D4 · How are touch targets fixed — one rule, or where they are drawn?

**A — One rule.** A `@media (pointer: coarse)` layer giving every control a 44px hit area via
an unpainted `::after` bleed, with a matching gap floor so `bleed = gap/2` and two bleeds
meet at the midline instead of crossing. Verified to move **zero** of the 992 baselines.

**B — Where they are drawn.** A mobile-first size scale (`h-11 sm:h-9`) in the cva, mirroring
the pattern already shipped at `drive-shell.tsx:141`.

**▸ Ruling: B, with A's behavioural half adopted.**

Two things decide it.

1. **A blanket rule silently falsifies load-bearing comments.** `.km-chat-act` is 11px because
   *"this row is the `auto` track of the grid above… a line taller than the eyebrow beside it
   moves the thread's top edge down."* A `min-height: 44px` under `pointer: coarse` moves that
   edge and leaves the comment explaining why it cannot, still sitting there, wrong, in the
   file the next debugger will read.
2. **A width-keyed fix is visible to the gate; a capability-keyed fix is not.** A verified its
   own rule moves zero baselines — and that is a cost, not a feature, because the reason is
   §4.1. `sm:` breakpoints *do* apply at 390px and *are* photographed.

A's honest concession stands on the record: a hit floor cannot lift 14×14 to 44. Those need
redrawing either way.

**Adopted from A**, because B concedes both are genuinely shared:
- `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` in
  `globals.css` — behaviour, not geometry; cannot cause an overlap.
- A's blanket rule used as a **diagnostic** — apply it locally, re-run the sweep, diff the
  enumerated set, revert it, fix the list by hand.
- A committed touch-target test with a ratcheting allowlist, and a `mobile-touch` Playwright
  project with `hasTouch: true`. **Both sides proposed this independently.** The assertion that
  matters is *no two interactive rects intersect* — the one a hit-area halo cannot pass and a
  height check cannot see. It found six real crossings on the day it landed, each one the same
  shape of mistake: something pinned or floating drawn over something that scrolls, without the
  scroller being told to keep clear of it.

---

### D5 · What shape is a dialog on a phone?

**A — Sheet by default** below `md`, centred above, geometry in one cva.

**B — A required `presentation` union** (`centred | sheet | page`), no default, geometry owned
once. The variety is not the bug; the duplicated className arithmetic is.

**▸ Ruling: B.**

B's inventory settles it. There are 14 `DialogContent` call sites — and confirms are not
among them: they already live in `AlertDialogContent`, 8 call sites, **all passing no
className at all.** Where this codebase separated presentation by content kind, the
duplication vanished by itself. That is B's thesis, already proven in-repo.

B also names the regression a sheet default would cause. `create-workspace-dialog.tsx:102`
auto-focuses its input, so the keyboard opens with the dialog; a `bottom-0` sheet is anchored
to an edge that is now moving, while a `translate-y-[-50%]` box re-centres in the shrunken
viewport and holds still. Three auto-focused single-field forms are made *worse*, not merely
different.

A required prop is a `tsc` failure, not a reviewer's diligence — and
`grep -rn 'presentation="centred"'` becomes the phone-audit worklist, which does not exist today.

**Adopted from A — three things A was simply right about:**
- **A real bug A found:** today's `DialogContent` is `w-full max-w-lg … sm:rounded-lg`. Below
  640px that is *zero side gutter and square corners*. Every centred dialog on a phone is
  already a bad full-bleed box.
- **The breakpoint is `md` (767), not `sm`** — matching `use-mobile.ts`, which every
  hand-rolled sheet already branches on. Anything else silently changes 640–767px.
- **A `visualViewport` owner** for `sheet` and `page`. It is the only correct answer for iOS
  (§4.2), nothing in the repo does it, and it gives the orphaned
  `--visual-viewport-bottom-inset` a consumer at last.

---

## 6. The plan

Ordered by what a person cannot do today. Each pass lands with its tests and its baselines.

### Pass 0 — make the gate able to see the work — **landed**
- `hasTouch: true` on a new `mobile-touch` Playwright project, scoped by `testMatch` so it
  runs only the touch suite and the two camera projects never do.
- `tests/visual/touch-targets.spec.ts`, committed: 25 routes, every interactive rect ≥44×44 or
  ≥32 with 8px of clearance, and no two hit areas crossing. Takes no screenshots, so it needs
  no approval step and cannot drift.
- **What it measured on landing: 155 controls below the floor, and 6 crossing hit areas.**
  Both ratchet. The 155 is a single number in `touch-target-budget.ts` that may only go down.
  The 6 are named individually in `KNOWN_CROSSINGS`, and the test fails from *both* sides — a
  new crossing is red, and a fixed one is red too, with the instruction to delete its line.
- One exclusion, and only one: a control scrolling under the floating top bar. That is the
  shell's documented design (the route runs under the glass, which is what makes it read as
  glass). It took the crossing count from 26 to 6. Everything else stayed.
- *Still to do in this pass:* portrait surfaces in `type-scale.test.ts`, which go red and stay
  red until Pass 2 lands.

### Pass 1 — the agent card on a phone — **landed** *(P0 #1, #2)*
- `.km-page` becomes a named container (`km-frame`), because a container query resolves
  against the nearest container **ancestor** — a rule targeting `.km-sheet` from inside a
  query on the sheet's own inline size silently never matches. That cost one debugging pass
  and is the single least obvious thing in this work.
- Below 30rem of frame: one column, `.km-sheet-left { display: contents }`, and the identity
  block with its three doors ordered above both panes so it is furniture, not a pane.
- The pane switch: two `role="tab"` segments, the second **named for what the card is
  holding** ("Launch intelligence", not "Work"). State is local; the URL seeds it on arrival
  and the switch never writes to it, so a link means the same thing on both devices.
- The `@container (max-width: 28rem)` compaction block is deleted — its stated premise was
  the 190px card, which no longer exists.
- **The header is one row.** An unprimed critique of the first attempt counted the bands —
  top bar, face, name, a row of three doors, the switch — and found **41% of the window
  spent on chrome before any content, with the conversation getting about sixty pixels on a
  screen whose selected tab said "Chat"**. It was right, and the first attempt had only
  fixed the horizontal problem. So the phone now gets the header a phone app has: the way
  out, a 44px face, the name, and everything else behind one control at the end.
  **159px → 44px.**
- **The three doors moved into that control.** They are not hidden by it: a row of 28px
  links inside a 170px column was unreachable, and a permanent 40px trigger that leads to
  all three is strictly more reachable. The unread mark moved with them onto the trigger, so
  closing the row cost none of the state it was carrying.
- **The conversation's own heading went**, because the switch directly above it already says
  "Chat" and a panel captioned with the word the tab just used is the same fact twice. The
  control it was carrying stayed.
- **Arriving at an agent means the conversation.** A bare agent path redirects to the
  agent's *folder*, which is the card having something to draw rather than a request to look
  at it — on a phone that difference decides the first screen, and it was landing readers in
  a file browser. A card named in the address still opens on the card.
- **A real bug the critique found:** the pane was seeded once at mount, so a link to a
  different card left the reader on the conversation and appeared to do nothing. The pane now
  follows the address by *value* (an object identity check re-fired every render), while the
  entry redirect settling is correctly not treated as the reader moving.
- Measured at 390: one 370px column, header 159→44px, **conversation 658px of 844 — 78% of
  the window, up from ~7%**. Doors **28→40px**, back button **26→40**, archive control
  **17→32**, segments 38. At 320: one 300px column, all of it holding.
- Desktop verified byte-identical: 469/941 columns, switch absent, original 28px doors — and
  the Docker gate agrees: of 18 changed baselines, **all 18 are mobile and none is desktop**.

### Pass 2 — the workspace home on a phone — **landed** *(supersedes the map fix)*
- `/w/:ws/agents` renders `AgentsHome` below 768px: the rail's own rows at full width,
  inside the product's `WorkspacePage` vocabulary, with the ring's add slot carried into the
  header as an outline button.
- Width, not capability — so the visual gate can photograph it (§4.1).
- The rows got a phone's geometry: app chips **28→36px** with 8px clearance, job rows
  **→44px** minimum, both stepping back to the pointer's numbers at `sm`.
- **Still open:** the map's unit bug (§3 #3) is unfixed and now desktop-only in effect.

### Pass 3 — targets and touch behaviour *(P1, P4)* — **partly landed**
The touch ratchet went **155 → 54** undersized controls and **6 → 2** crossing hit areas.
The single biggest step was the shell: the top bar's three tabs, the workspace switcher and
the account trigger are on every route, so raising them from 36 to 44 removed 66 in one
change and cost four pixels of window height. The rest is still to do:
- Mobile-first size scale in `button`, `checkbox`, `input`; `summary` rows; the `km-*` controls
  inside their container query; shell controls to 44px.
- `touch-action: manipulation` and tap-highlight policy in `globals.css`.

### Pass 4 — navigation and the missing doors *(§4.3)*
- Shell controls to 44px — **landed** (see Pass 3).
- Account menu becomes a bottom sheet on touch, carrying Train and the settings surfaces.

### What two unprimed critiques changed
Both passes were reviewed blind, by an agent given only the screenshots. The first scored
nothing but counted the bands and found **41% of the window spent on chrome before any
content**, with the conversation reduced to about sixty pixels — which sent Pass 1 back for
the header rebuild. The second scored the result **6/10** and was right about all of it:

| what it found | what it was |
|---|---|
| the switch's selected and unselected fills were **the same RGB value** | true — `--km-glass` over `--km-bg` composites to within four values of `--km-slab`, so the product's primary view control distinguished its states with a hairline |
| a browser **broken-image glyph** shipping on the workspace home | true, and a real product bug: `AppAvatar` had a monogram fallback for *no* icon and none for an icon that fails to load — so every lapsed grant, deleted file and offline replica drew a torn page |
| the overflow menu was **30px rows** | true — a desktop dropdown that had never been re-thought for touch, in the one context where the only thing a reader does is tap |
| the unread dot was **near-black at 5px**, where the app's own language is a blue 8px dot | true, and the cause is the same one the rail's header warns about: the menu is portalled to `document.body`, outside the element that declares the `--km-*` tones, so it fell back to `currentColor` |
| the archive control's icon sat **9.5px below its own label** | true — baseline alignment on a row that had lost its heading |
| the primary CTA was 36px, back and overflow 40, chips 35 | true; all raised |

Everything in that table is fixed. What it raised and this work has **not** answered:
the empty conversation spends 46% of the phone on a blank panel with no suggested prompts;
the composer's quality meter is 30px of permanent cryptic chrome; "Ask Duet anything" appears
on an agent's own page; and the question panel has two competing submit affordances. Those
are product questions, not layout ones, and they are listed here rather than quietly dropped.

### Pass 5 — dialogs *(D5)*
- `presentation` union; migrate 14 callers and 5 hand-rolled sheets; fix the centred
  full-bleed bug; one `visualViewport` owner.

### Pass 6 — the pointer-only affordances *(P3)* — **landed**
Every one of the four now follows the `files-surface.tsx:870` pattern — drawn on touch,
revealed on hover — rather than existing only under a pointer:

| what used to disappear on touch | now |
|---|---|
| a stacked message's timestamp | `opacity-60`, `md:opacity-0 md:group-hover:opacity-100` |
| the rename pencil on a session title | same |
| the "opens" arrow on an agent-surface row | same |
| the inline-edit control in shared UI | same, and 36px on a phone |

The drive's density toggle keeps its icons and gains a finger's box (28 → 40). Its words
were never actually lost — the toolbar's own overflow menu spells the same choice out — so
the tooltip is the pointer's shortcut to a label that has a home, not the label itself.

### Pass 6b — the squeezed layouts *(P2)* — still to do
- Stack the two- and three-column rows below `sm`; let api-key scopes wrap.

### Deliberately not in this plan
- **Pan and pinch on the map.** A new subsystem; the unit fix covers small and medium fleets,
  and a large fleet's answer is the rail.
- **A bottom navigation bar.** Ruled against in D3.
- **Changing what `/agents` opens to on a phone.** Ruled against in D2; revisit with telemetry.

---

## 7. How this gets checked

The screenshot suite proves stability, not correctness, and §4.1 is what happens when it is
trusted for more than that. So the checks are layered:

| layer | catches |
|---|---|
| `touch-targets.spec.ts` (touch project) | undersized and overlapping targets across 25 routes — 155 and 6 at landing, **120 and 2 now**, both ratcheting down |
| `type-scale.test.ts` with portrait surfaces | the floor being measured in the wrong unit, ever again |
| a geometry assertion per pane | two panes on screen at 390, or a pane under 90% of the window |
| a className lint on `DialogContent` | geometry leaking back out of `dialog.tsx` |
| the mobile baselines | composition, hierarchy, and what a person actually sees |
