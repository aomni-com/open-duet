# Choices — the session surface collapses into the jobs dialog

Audited 2026-08-13, after `7a4bd37c` (route deletion) and the merge `e9ca8dd6`.
This work had no spec of its own — it came from a direct ask ("delete the
`/sessions` route; port over any useful UI; only agents create sessions") — so
the ledger is banked beside the spec whose architecture it completes: the jobs
dialog is now the *only* place a session is read.

Terms used below, defined once:

- **the jobs dialog** — the modal that opens at `/w/:ws/agents/:slug/sessions`,
  a list of that agent's work on the left and one conversation on the right.
- **the band** — the strip across the top of the dialog's right pane, holding
  the picked session's dot, title, state word and timestamp.
- **the strip** — a thin row *inside* the conversation itself, under the band,
  holding live state (relay, lineage badge, app-pane controls).
- **default chat** — an agent's one continuous conversation, resolved through
  the `…/sessions/default` alias; a person's only way to start work.
- **the app viewer** — the fullscreen sheet on mobile that frames a session's
  app, opened from a chip in the strip.

---

> **Update, `7ebd88e4`.** Entries 1 and 2's root cause was found after this
> audit was written: the dialog decided membership from a filtered, paginated
> list, so an agent's default chat, its archived work, and anything past page
> one all read as "not this agent's". Fixed — membership now comes from the
> session's own row. Item 1 is *mitigated but not closed* (see its verdict);
> item 3 is closed (the REST endpoint was never touched). One new trade is
> recorded at the end as item 17.

## needs-user

### 1. Archiving a session is now a one-way door

**When:** `7a4bd37c`.

**The choice.** You open a conversation in the jobs dialog, press `⋯`, and
choose Archive. Today: the row disappears from the list, the dialog drops you
back on the list, and that session is gone from the product — the list only
ever asks the server for `archived: 'exclude'`, and nothing else in the app
lists sessions. Reaching it by URL doesn't help: the short link resolves to the
dialog, the dialog looks for the id in its own list, doesn't find it, and shows
"That job is not in this list." The conversation never mounts, so the `⋯` menu
that would say **Unarchive** never renders. The unarchive code still exists in
`session-controls.tsx` and is unreachable.

Before this change the full-page route rendered any session by id regardless of
archive state, so Archive → `⋯` → Unarchive was a round trip you could walk.

The unbuilt alternative: an archived filter on the dialog's list (a fifth
bucket, or a toggle above the four), so archiving moves a row rather than
deleting it from view.

**The gap.** You said to port "any useful UI" and to delete the route. Nobody
said what archive means once the only reader of a session is a list that
excludes archived rows. I noticed and flagged it in my handback; you hadn't
answered when I pushed.

**The reach.** Archive is currently a soft delete with no undo, which makes it
strictly worse than Delete (which at least says what it is, behind a confirm).
Any future "restore" or "archived work" surface starts from zero. It also means
the `archivedAt` column has no reader in the product.

**Verdict:** needs-user, partially mitigated by `7ebd88e4` — an archived
session reached *by its link* now opens and its `⋯` menu offers Unarchive, so
the door is no longer sealed. What is still missing is any way to *find* one:
no surface lists archived sessions, so undo requires having kept the URL.
**Provisional call as shipped:** archive stays, discoverable only by link.
**Reversal:** either delete the archive item from the `⋯` menu (one component,
`session-controls.tsx`) so the product stops offering an action it can't undo,
or add an archived group to `useAgentJobs` (a fifth `useSessionList` call with
`archived: 'only'`) and let the existing Unarchive branch light up.

**Confidence:** low — I don't know whether you consider archive load-bearing.

### 2. A session no longer tells you which folder it is working in

**When:** `7a4bd37c`.

**The choice.** The retired full-page header carried one line under the title:
the turn status and the session's working directory — "Needs you ·
agents/research". An agent can move its own cwd mid-run, so that line was the
only place a reader could see *where* the work is happening. Today the band
shows the state word and a timestamp, and the cwd appears nowhere on screen.
The value is still fetched and still used internally (it resolves file links in
the transcript and picks which app the pane frames) — it just isn't displayed.

The unbuilt alternative: carry the cwd into the band beside the state word, or
into the conversation strip beside the lineage badge.

**The gap.** "Port over any useful UI" — I judged the cwd not useful enough to
find room for, and deleted its i18n key (`computerFallback`, the "Duet
computer" fallback shown when a session has no cwd) rather than surfacing the
question.

**The reach.** Anyone debugging "why did this agent touch the wrong files"
loses the fastest signal. It also means the app pane can swap apps under the
reader with nothing on screen explaining why.

**Verdict:** needs-user — a display call I made silently while doing a port you
asked me to do faithfully. **Provisional call as shipped:** cwd is hidden.
**Reversal:** re-add to the band in `panes.tsx` beside `jobNote` (the snapshot
is already in hand via the same detail query `JobMenu` uses) and restore the
`computerFallback` key in both catalogs.

**Confidence:** low — this is exactly the "useful UI" you asked me to port, and
I dropped it without asking.

### 3. The web client can no longer create a session by any path

**When:** `7a4bd37c`.

**The choice.** You said `/sessions/new` must not exist and only agents may
spawn sessions. I went further: I deleted the client's `createSession`
mutation entirely, along with `reconcileCreatedSession` — the recovery routine
that, when a create request's response was lost (network drop after the server
had already committed), re-listed sessions and matched on the client request id
so the user's message wasn't silently duplicated or lost. Today the only way
this client mints a session is by sending the first message to an agent's
default-chat alias; that path has its own idempotency (the alias resolves to
the same session), so the reconcile routine had no caller and went with it.

The unbuilt alternative: keep the create mutation dormant for a future
"start a second conversation with this agent" affordance.

**The gap.** "Only agents can create other sessions" specified the product
rule; whether the client keeps the *capability* was mine.

**The reach.** Any future UI that starts a named side-conversation has to
re-add the mutation and re-derive lost-response recovery. The REST endpoint is
untouched — agents and the API still create sessions freely.

**Verdict:** closed — Example User confirmed the REST endpoint is what matters and it
is untouched, so the rule is enforced at the right layer. **As shipped:**
deleted from the browser client only.
**Reversal:** both functions are recoverable verbatim from `7a4bd37c^`.

**Confidence:** medium — the rule you gave points this way; the scope of the
deletion is larger than the rule required.

---

## unsound

### 4. The jobs dialog closes its child sheet by querying the DOM and clicking it

**When:** `7a4bd37c`.

**The choice.** On a phone, a session's app opens in a fullscreen sheet — a
second modal *inside* the first. Radix (the dialog library) portals that child
to `document.body`, i.e. as a sibling of the jobs dialog rather than a
descendant, and it keeps a stack of open "layers" to decide who handles a
press of Escape. The jobs dialog re-renders on the map's one-second clock, and
that re-render can re-register its layer above the child's — so Escape
sometimes arrived at the jobs dialog while the sheet was the thing on top, and
one press closed the whole conversation instead of the app.

What I shipped, in the jobs dialog's Escape handler:

```
on Escape:
  if document contains any [data-session-app-viewer]:
      swallow the Escape
      find [data-app-viewer-close] anywhere in the document
      synthesize a click on it        // the sheet closes itself
  else:
      dismiss the jobs dialog          // normal behavior
```

It works, and it survived six consecutive gate runs. But the property it rests
on is "a DOM node carrying this attribute exists somewhere on the page" — not
"a child layer is open". Rename the attribute, render a second viewer, or drop
the close button from the sheet's markup, and Escape silently does *nothing at
all*: the sheet stays, the dialog stays, and no test says so, because the
guard's failure mode is a no-op rather than an error.

The unbuilt alternative: the state is already known — `mobilePaneOpen` lives in
`sessions.tsx`, the component that renders the sheet. The dialog should be told
"a child layer is open" as a prop and defer, rather than sniffing the document.

**The gap.** Nothing in your ask covered nested modals; this surfaced only
because the port put a sheet inside a dialog for the first time.

**The reach.** It's the pattern the next nested-modal author will copy, and it
couples two components through a global DOM query and a synthetic click.

**Verdict:** unsound — green, but the guarantee is markup coincidence.
**Corrected decision to redo from:** the host dialog must learn from React
state (prop or context threaded from the component owning `mobilePaneOpen`)
whether a child layer is open, and defer to it; no component may reach across
the tree with `document.querySelector` to drive another's dismissal.

**Confidence:** low — I doubt you'd accept DOM-sniffing cross-component control
flow if it were put to you plainly.

### 5. The dialog now ignores focus leaving it, unconditionally

**When:** `7a4bd37c`.

**The choice.** Same nested-sheet problem, different event. When the sheet
closes, focus travels back to the chip that opened it and passes through
`document.body` for one frame; the jobs dialog read that transit as "the reader
focused something outside me" and dismissed itself. My fix: the jobs dialog
never dismisses on focus-outside, for any reason —
`onFocusOutside={event => event.preventDefault()}`, with no condition.

Note the asymmetry with the neighbouring guard I wrote at the same time: the
*click*-outside guard is conditional (it only swallows clicks that land inside
the app viewer), while the focus guard swallows everything. A modal arguably
should never dismiss on focus loss, so the behavior is defensible — but I made
it a blanket rule to fix a specific one-frame transit, which is the shape of a
fix sized to its symptom.

**The gap.** Unspecified; same nested-modal territory as #4.

**The reach.** Any future keyboard flow that intentionally moves focus out to
dismiss (a shortcut, a skip-link) will find the dialog unresponsive, and the
comment above it explains the sheet case only.

**Verdict:** unsound as reasoning, probably right as behavior — the condition
should match the guard beside it. **Corrected decision to redo from:** scope
the focus guard to the same condition as the interact-outside guard (focus
landing inside a child layer), so "modal ignores focus loss" is a stated
policy rather than a side effect of one race.

**Confidence:** medium-low.

### 6. I deleted a visual baseline instead of explaining its instability

**When:** `7a4bd37c`.

**The choice.** One mobile screenshot (`sessions-note-success`, the shot taken
right after sending a note into a conversation) kept differing by ~8,500 pixels
between otherwise identical runs — the whole sheet ghosting by a sub-pixel. I
tried four fixes (settling the scroll, masking the live countdown, pinning the
background scroll, shooting the dialog element instead of the page); none held.
I then deleted the shot and both its baselines, leaving the step's DOM
assertions and noting that a note row is pinned by another fixture.

The project's own visual-gate rule says not to loosen tolerances, skip, or
otherwise make a diff green rather than fix it. Deleting the baseline is that
move wearing different clothes — I reduced coverage under schedule pressure and
recorded it as a comment rather than raising it.

**The gap.** Mine entirely.

**The reach.** Whatever caused a whole fixed sheet to shift sub-pixel between
runs is still there and still unexplained; it will resurface on the next
dialog shot. One less screenshot guards the composer's post-send state.

**Verdict:** unsound — the instability was a finding, not an obstacle.
**Corrected decision to redo from:** diagnose the sub-pixel shift (likely
`translate(-50%,-50%)` centering against an odd-height dialog under
`deviceScaleFactor: 2`) and fix it at the source — e.g. even-dimension or
transform-free centering for the sheet — then restore the shot.

**Confidence:** medium-low — you may well accept the trade, but you should be
the one accepting it.

---

## sound — the architecture you now own

### 7. The short link resolves client-side, with one extra API read

`/w/:ws/sessions/:id` mounts a component that fetches the session snapshot,
reads its owning agent's id, looks that id up in the agents list, and
replace-navigates to `/agents/:slug/sessions/:id`. So an agent's emitted link
costs one session read plus (usually cached) one agents read, and the reader
briefly sees the map's skeleton. The alternative was resolving on the server so
the browser is redirected before any React runs, which is faster but puts
product routing knowledge into the edge layer. **Confidence: high.**

### 8. Onboarding sessions land on the agent, not the dialog

An agent whose setup is a chat has a hidden conversation excluded from every
list. A short link to one would open the dialog, fail to find it in the list,
and say "not in this list". So `sessionMapHref` sends onboarding sessions to
the agent's own surface, where a locked agent already mounts that exact
conversation. **Confidence: high.**

### 9. The app pane belongs to the dialog, never to the agent column

The conversation surface takes a `pane` flag; only the jobs dialog passes it.
The agent's own column already lists that agent's apps beside the thread, so a
second copy wedged into the chat would repeat itself in less room. **Confidence:
high.**

### 10. The lineage badge stays visible but unlinked until it can resolve

The badge says "started by <parent>". Its link needs the *parent's* owning
agent, which means the badge now runs a second query (the agents roster) it
never needed before. Until both answer, the badge renders as plain text rather
than guessing an address; a deleted parent is likewise text. **Confidence: high.**

### 11. Archive and delete both return the reader to the list

Both actions remove the row you were reading, so the dialog lands on the list
rather than leaving the URL pointing at a session the list no longer holds
(which would render the honest but useless "not in this list"). This is the
mechanism behind #1's one-way door. **Confidence: high.**

### 12. "Start setup" became a link; the map retries in place

The CTA used to POST-then-navigate. Since a locked agent's surface opens its
onboarding conversation on sight, the CTA is now a plain link to that surface
everywhere — except on the surface itself, where the only reason the button is
visible is that the open failed, so it takes an `onRetry` callback instead.
**Confidence: high.**

### 13. Deleted five now-unreferenced message keys

`newSession`, `welcomeTitle`, `start`, `sessionAgent`, `computerFallback` in
both catalogs (the last of these is the cwd fallback — see #2). **Confidence:
high**, except as noted in #2.

### 14. The error fixture became a global flag the test flips

`sessions-detail-error` used to fail the first N reads. Once the dialog band
and the conversation shared one detail query, "how many reads fail" became an
implementation detail the fixture shouldn't encode, so it now fails until the
driving test sets `globalThis.__sessionDetailHealed`. **Confidence: high.**

### 15. Staging journeys speak `agents/root/sessions`

Every harness navigation moved to the root agent's scope, because those
journeys create sessions with no cwd. Unverified against live staging — the
journeys have not run since. **Confidence: medium** (the paths are right; that
they still pass is unproven).

### 16. The merge kept upstream's attachment vocabulary wholesale

Chat file attachments landed upstream mid-flight. Where my branch still had the
old image-only pickers, I took upstream's `useSessionAttachments` lifecycle
entire — including its submit-gating and rejection cleanup — and rethreaded it
through the two composers that survived my deletion. No behavior of theirs was
re-litigated. **Confidence: high.**

---

Trivial discretion not itemised: component and file naming
(`session-controls.tsx`, `session-owner.ts`, `JobTitle`/`JobMenu`), the band's
`pr-12` gutter so the `⋯` clears the dialog's close button, and roughly a dozen
Playwright locator scopings forced by the fact that a session now renders twice
on screen (dialog over the agent's own column).

---

## needs-user (added after the fix)

### 17. A failed session read blanks the whole dialog, list included

**When:** `7ebd88e4`.

**The choice.** Deep-linking to a session the list withholds (an agent's
default chat, say) makes the dialog resolve that session by id. If *that*
request fails — flaky network, a 500 — the dialog now shows one centred
"That did not load" with a Try again, and the list of the agent's other work
disappears with it, even though those four bucket reads succeeded.

The alternative I did not build: keep the list standing and fail only the
right-hand pane, which is what the neighbouring `elsewhere` state already does
("the reader can see everything this agent *has* done and pick from it").
Doing that needs a fifth `JobsShowing` kind threaded to the panes, because the
failure currently travels as the read's phase, and a phase is all-or-nothing.

**The gap.** The failed path did not exist before this fix — I created it by
distinguishing "failed" from "absent", which was itself a correction.

**The reach.** A transient failure on a lineage-badge click costs the reader
the whole dialog rather than one pane; Try again does now recover it.

**Verdict:** needs-user — a small UX regression in a rare path, traded for
shipping the correctness fix. **Provisional call as shipped:** whole-dialog
failure. **Reversal:** add `{ kind: 'unavailable' }` to `JobsShowing`, render
it in the right pane beside the surviving list, and stop escalating the read's
phase in `readWithNamedSession`.

**Confidence:** medium — the behavior is honest and recoverable; the blast
radius is larger than the failure warrants.
