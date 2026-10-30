# Choices ledger — final

Every decision made **where the spec was silent**, re-audited against the code
that actually shipped rather than against the pass it landed in. Provisional
verdicts are resolved to their end state, reverted entries dropped, duplicates
merged. Choices only — gate results and review findings live in the commits.

Ranked **least confident first**: the top of this list is what deserves your
attention, the bottom is what you can skim.

---

## Needs you — I made a call you may want to change

### 1. Duet's dialog lists the whole drive's work, including other agents'

Open the jobs door on the drive's centre and you see Ops's jobs and the
Librarian's, not just the work nobody claimed.

This follows **decision 4** literally — you settled that Duet's dialog is scoped
"the same way its door is", and that door has always gone to the unfiltered list.
But the plan also recorded (finding F3) that `ROOT_AGENT_SCOPE` is a *real*
"belongs to nobody" filter, and that is the scope matching the dialog's own
heading. So the honest summary: Duet's dialog says "Duet" at the top and shows
everybody's work.

I paid for it rather than changing it — the projection now carries each job's
owner and Duet's rows print it, so the list is at least not silently
misattributing. **Changing it is one line** in `agents-map.tsx`
(`{kind:'drive'}` → `{kind:'agent', agentId: ROOT_AGENT_SCOPE}`). The door
follows automatically because both read one value — but note it *changes
destination* when it does, from the unfiltered jobs page to
`?agent=root`. That is the correct destination for the narrowed reading; it is
not a no-op.

### 2. Five components and seven translated strings are now unreachable

`EmptyStage`, `SkillChips`, `FileRows`, `Group` and `Row` in
`agent-surface/parts.tsx` can no longer be drawn by anything, nor can the strings
they read (`tabs.skills`, `tabs.files`, `emptySkills`, `emptyFiles`, `emptyApps`,
`connectApp`, `folder`).

Why: the card only reaches its "this agent has nothing" state when the chip row
is empty, and the row always contains Files — so that state cannot happen. This
was already true before the feature (finding F9); what the feature did was remove
the last fixture that drew those components anyway.

**Decision 3 kept the "Connect an app" link on purpose**, which is why I did not
delete them — you asked for that link to survive, and deleting the block it lives
in would have overridden you. But it survives inside a branch that cannot
execute, and it costs a prop threaded through the route, an icon import, and
seven translated strings in two locales. Either delete the five components and
their strings, or give the chip row a way to be genuinely empty. **Deliberately
left for you.**

### 3. Nothing in the dialog says it is a list of jobs

Its title is the agent's name, on the reasoning that the word for the list is on
the door underneath. Two independent unprimed reviewers each asked what the list
contained — the second noting that the only occurrence of "job" is the link you
reach last, and that on a phone the agent's name appears twice within 120px.

I left it, because the title is a settled slice-03 decision and this is a wording
question rather than a defect. But two readers out of two is a strong signal, and
the cheapest fix is a second, quieter line in the header band.

### 4. The coloured dots beside job rows are decorative, not informative

Within a group every dot is the same colour, so it never separates two rows — it
restates the heading three lines above. Three of the five groups then show an
empty mark column, which reads as "the marks ran out".

I kept them because they are the one thread tying this dialog to the canvas
underneath: the same coral sits on the agent's face out on the map, and decision
5 already gave up the map's glass. If a later reader still calls them
decorative, **drop them — the headings carry the meaning on their own.**

### 5. Duet behind the sessions wall has an empty row under its name

The CSS rule that hid an empty action row was deleted on the premise that every
agent now has at least one door. True except here: Duet has no Train or Settings,
and the Jobs door is withheld when the workspace lacks the sessions scope — so
the row renders empty with its gap intact. Cosmetic, narrow, uncaptured by any
fixture.

---

## Judgement calls I am confident in, but worth knowing

### 6. The map's Escape rule was not unified with the drive's

Both surfaces now answer "does Escape leave me". The drive's version also checks
the focused element and queries the DOM for an open dialog; the map's only checks
whether something already handled the key. They differ **because they listen in
different phases** — the drive runs *before* the dialog library, where the
"already handled" flag is always false, so its DOM query is what saves it.
Merging them today gives one function with a phase flag and two dead branches per
caller. A third surface wanting this is the moment to extract.

### 7. The playground hand-copies the session surface's bare skeleton

The fixture reproduces the real conversation surface's scroller, masks and footer
by hand, because the real one is a query surface a fixture cannot mount. This bit
once already: a fix to the real footer did not reach the screenshot until the
copy was updated too. The call site names the drift risk and names the live path
as the check.

### 8. `job-groups.ts` sits one directory above its only two callers

Both are under `agent-jobs/` now that the card's jobs panel is gone. Left in
place because it is the shared vocabulary between the dialog and the map, and
moving it is churn — but note its module header still opens by describing the
deleted panel.

---

## Settled, and I would defend these

### 9. The stacking threshold is 80rem, measured rather than estimated

An earlier pass estimated ~54rem by assuming the left column stays 46% of the
surface. It does not — the `clamp()` takes its 33% middle at exactly the widths
where a third door is in question. Sweeping the real fixture and watching the
door row wrap puts the crossing at 1226px in Spanish. **Spanish decides it**;
English fits 109px earlier. The keeper: an estimate from one slice is not a
measurement in the next.

### 10. The two job views are merged without sorting

"Every job" is two queries because the wire has no third view. The merge
deliberately orders nothing: a job is active exactly while its state machine is
unfinished, and the display buckets split on the same fact, so the two views
partition onto the buckets and never interleave. A timestamp sort would fight an
answer the grouping already gives, every time a finished job is newer than a
running one. It only dedupes — a job can cross between the two requests and come
back in both.

### 11. A half-failed read keeps the rows that arrived

If one view fails, the read reports an error but keeps the other half's rows, so
a transient refetch failure cannot empty a populated dialog. Error outranks
pending, because a read with a dead half never completes and a spinner over rows
that are not coming is worse than saying so.

### 12. The map's Escape listener must stay on the bubble phase

That is the whole reason it can see that something else already handled the key.
A future "consistency" pass moving it to capture would silently restore the bug —
one Escape closing a dialog *and* flying the reader off the agent — with the
guard still present and still looking correct.

### 13. The dialog borrows the map's state colours and none of its material

The stylesheet block declaring the map's variables also ended with the map's own
geometry, so letting the dialog into that selector list handed it a full-width,
statically positioned box. The rule is split now: **variables are shareable, a
surface's geometry is not.**

### 14. The agent's name wears the doors' glass plate when the block stacks

Beside the face it sits clear of the wire running to the core; under the face it
sits on it, and a text halo cannot help because the wire crosses the letters'
counters. An unprimed reader called it "a leftover SVG path… unattached to
anything" — it read as a rendering fault, not a connection.

### 15. `bare` gives the gutter back to its host but keeps the measure

Two bugs in one mode, both invisible until a bare host got wide or got a phone:
the thread opened on 80px of dead band (padding for a header `bare` removes), and
the composer ran full width while the thread stayed capped — a 117px
disagreement in a thousand-pixel pane. Both fixes reach the agent's chat column
too.

### 16. Copy keys were replaced, never reworded

Every string whose meaning changed was deleted and a new key added. A reworded
key with a forgotten Spanish half ships a silent lie in one locale, and the
catalogue test only catches a *missing* key, never a wrong one.

### 17. `onRetry` is required, and the read grew a refetch to make it so

It was optional while nothing in production could supply one, which made "Try
again" a button only the fixture could draw and left the real failed dialog
offering nothing but a link off the map. A failed read is the one state where
that door is the wrong offer. Both views refetch together — one fresh list beside
one stale one puts a job in two buckets at once.

### 18. Rows outrank the phase when deciding what the dialog shows

Otherwise a history-refetch failure would blank a dialog holding perfectly good
active rows.

---

## Recorded because you decided it, not me

### 19. The live staging journey was cut

`AGENTS.md` says a change this size ships with its own staging e2e journey, run
once as a closeout gate. I asked rather than assumed, because that run mints
identities and provisions real VMs on a shared account, and a leaked VM steals
CPU from production workspaces. **You chose to skip it entirely.** The closeout
gate is the local sweep plus the in-app probe. A deliberate deviation, recorded
here and in slice 07 so nobody restores it by reflex.
