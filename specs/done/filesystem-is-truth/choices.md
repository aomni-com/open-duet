# Choices — the filesystem is the source of truth

Decisions made on the user's behalf while building the reap rail, the agent-fire
cascade, and the marketplace cleanups that followed from them. The instruction
was "if the folder is gone, the thing is gone"; everything below is a gap that
sentence left open.

Every entry below is settled. The two that needed Example User's call — whether
un-shipping takes the files as well as the row, and which directory names we
delete unasked — were confirmed as built on 2026-08-11. Nothing here is open;
later passes inherit all of it as given.

---

## decided by Example User

### Un-shipping an app deletes its row but leaves its files

**When** — `46d567c4`.

**The choice.** You publish an agent to the hub. Ten people install it. Their
workspaces each get an `apps/board` folder full of your files, plus a database
row saying "there is an app here". Later you delete that app from the hub.

Before this work, every subscriber's row was switched *off* and left in place —
visible on their map forever, and unremovable, because a marketplace-managed app
refuses direct deletion. You said it should delete.

What the work does today: the **row** is deleted, so the app disappears from the
map and the roster. The **folder stays on disk**. Separately, the file sync — a
mechanism that already existed — removes the shipped files it can prove nobody
touched, keeps anything edited as a conflict copy, and keeps anything added.

So the end state for a subscriber is: app gone; their edits and additions still
sitting in a plain folder.

The unbuilt alternative: delete the folder outright with the row, so
un-shipping leaves nothing behind at all.

**The gap.** "It should delete" doesn't say whether *it* means the registration
or the files. You had also said, earlier, that local changes in shared agents
must survive — which points the other way.

**The reach.** This is the rule for every future "the publisher took it back"
case. If it's wrong, subscribers accumulate orphan folders forever; if the
alternative is wrong, a publisher can delete a subscriber's work remotely.

**Verdict — confirmed.** Row-only, as built: deleting the *app* means the
registration, and the existing per-file rule decides the files. A publisher can
retract what they shipped; they cannot reach into a subscriber's folder and
delete what that subscriber has since made of it.

Reversing it would be one place — `retireDroppedApps` in `marketplace/model.ts`
would additionally ask the gateway to remove the folder — but this is the rule
now, and a future pass should not re-open it without a new reason.

---

### Which directory names count as "derived"

**When** — `4ecfae9d`.

**The choice.** When the publisher's files are removed, anything they never
shipped is treated as the user's and kept. Installed dependencies are never
shipped — they're built on the subscriber's own machine — so `node_modules`
survived as "the user's", which is why you saw a folder containing nothing else.

The work adds a list of directory names that are **output, not authorship**:
`node_modules`, `__pycache__`, `.venv`, `.next`, `.nuxt`, `.output`,
`.svelte-kit`, `.astro`, `.angular`, `.turbo`, `.parcel-cache`, `.vite`,
`.cache`, `.gradle`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`. Those are
removed with the files that produced them.

I deliberately left off `dist`, `build`, `out`, `target`, `vendor`, `coverage`.
Every one is commonly hand-written or committed, and being wrong about them
deletes someone's work to save disk.

**The gap.** You said "node_modules, as well as any other cache files from
popular frameworks" — which frameworks, and how aggressive, was mine.

**The reach.** Every name on this list is a name we will silently delete from
someone's drive. Adding one is one line and needs no other thought; removing one
later doesn't recover what was already deleted.

**Verdict — confirmed.** The conservative list stands. A name earns its place
only if its contents are always regenerable, which is why the ambiguous six are
absent; adding one later is a single line in `DERIVED_CONTENT_SEGMENTS`
(`contract/src/drive/index.ts`), and that is the deliberate place to argue it.

---

### There is no "retired" app — un-shipping deletes, and switched-off means installing

**When** — the follow-up to the un-shipping decision above.

**The choice.** A second session had built a third app state: *retired*, meaning
"your subscription still exists, but the publisher dropped this one app." It had
its own sentence on the card ("The publisher no longer ships this app"), its own
menu, its own screenshot, and its own rule letting you delete it — the only
managed app you were allowed to delete.

Confirming that un-shipping DELETES the row removed the only thing that produced
that state. And `appIsRetired` was defined as "subscription-owned AND switched
off", which after the change can only ever match one thing: an app whose row was
written the instant you installed it and which is waiting for its first pull.
Every match would have been an app that was still arriving, told its owner the
publisher had abandoned it, and offered a delete that races the download.

So the concept is gone and its conjunction is renamed to what it actually
detects: `appIsInstalling`. The card now says the app is still arriving; a
switched-off REPLICA still says "turn it back on", because that reader really
does have a switch.

**The gap.** Two sessions modelled the same event differently and the codebase
asserted both — one file said "the sync retires the row rather than deleting
it" while the sync deleted it.

**The reach.** A managed app is now never deletable, in any state; it leaves by
uninstalling its subscription. The one visible cost: when a publisher drops an
app, it disappears from the subscriber's map with no notification. The folder
and everything they made in it stays.

**Verdict — confirmed.** Not merely simpler: keeping `appIsRetired` meant every
row it matched was mislabelled. The contract test asserting this had already
been written — `a managed app that is switched off is installing, and is nobody
to delete` — and was RED on `staging` until this landed.

**Confidence — high.**

---

## sound

### A recursive delete stopped reporting how many entries it removed

**When** — `46d567c4`.

**The choice.** You asked why a delete had a size limit at all. The honest
answer: deleting walked the entire tree first to count it, the count went into
an `affectedEntries` number in the response, and the walk needed a bound so it
couldn't run forever. Nothing in the product ever read that number — only test
mocks did.

So the walk is gone for recursive deletes, and with it the bound. The response
now omits `affectedEntries` when nothing counted. A non-recursive delete (one
empty directory) still counts, because it's free.

The unbuilt alternative: keep counting, just raise the ceiling — which is what I
did first, before you pushed on it.

**The gap.** "Why have a limit at all" invited removing the limit; changing the
shape of a response was my extension of that.

**The reach.** `affectedEntries` is now optional in the wire contract. Anything
that later wants a count from a recursive delete has to re-introduce the walk.

**Verdict — sound.** The field had no consumer, and keeping a bound purely to
protect the machinery that produced an unread number is the definition of debt.

**Confidence — medium.** Sound on evidence; you may still want the number.

---

### An absent folder never passes through "needs repair"

**When** — `111a80b5`, prompted by your question about the gap.

**The choice.** You delete a folder in Drive. The system notices within about
five seconds, but waits for three consecutive sightings before deleting the row,
so a half-finished file move can't destroy anything.

The question was what the app shows during those ~15 seconds. Originally it went
to "Folder link needs repair" on the first poll and only then to deleted — so an
app spent its last ten seconds telling you to fix a folder you had just deleted
on purpose.

Now nothing happens at all until the deadline: the row is untouched, then it's
gone. "Needs repair" means only one thing — a folder that *is* there but can't be
identified.

Bonus property: a folder that vanishes for two polls and comes back now leaves
no trace at all, where before it left a state flip and two audit entries.

**The gap.** The instruction covered the end state, not the interval.

**The reach.** "Broken" now has exactly one meaning, which is what let the
message on the card finally say something true.

**Verdict — sound.** A state that is guaranteed wrong for its whole lifetime
should not exist.

**Confidence — high.**

---

### Reaped anchors are retired, not deleted

**When** — `484f4ab8`.

**The choice.** An *anchor* is the row that ties a folder path to an app or
agent. When the app is reaped, the anchor could be deleted outright or marked
"orphaned" and left.

I mark it orphaned. That retires it from every set the VM is asked about, so it
stops being re-examined every poll — but the row survives, and if a folder ever
reappears at that exact path, registering there revives the same anchor instead
of minting a new identity.

The unbuilt alternative: delete it, and let a future folder at that path get a
fresh identity.

**The gap.** Unspecified; the existing code already orphaned anchors on the
normal delete path, so I matched it.

**The reach.** Orphaned anchors accumulate and nothing collects them. They are
invisible and small, but they are rows.

**Verdict — sound.** Consistent with the established convention, and preserving
path identity is what makes re-registration idempotent.

**Confidence — high.**

---

### Firing an agent deletes rows first, files second

**When** — `484f4ab8`.

**The choice.** Firing does two things: remove the database rows, and delete the
folder. If the process dies between them, order decides the wreckage.

Rows first: you're left with an ordinary folder nothing points at — inert.
Files first: you're left with rows pointing at a folder that doesn't exist —
exactly the residue this whole change exists to eliminate.

**The gap.** Unspecified.

**The reach.** Any future "delete the thing and its files" follows this order.

**Verdict — sound.** One order fails into litter, the other into the bug.

**Confidence — high.**

---

### The reap waits for three sightings

**When** — `484f4ab8`.

**The choice.** How many consecutive polls must report a folder missing before
its row is deleted. I chose three — roughly fifteen seconds while a workspace is
active, ninety while idle.

One would react to any momentary blip. A much larger number would leave deleted
apps visible for minutes.

**The gap.** Entirely unspecified.

**The reach.** It's the only thing standing between a transient filesystem
hiccup and permanent row deletion. You rejected my attempt to add a second,
larger threshold for the "whole drive looks empty" case — correctly — so this
single number now carries that weight alone.

**Verdict — sound**, with the caveat that it is a guess calibrated to the poll
cadence, not to measured failure rates.

**Confidence — medium.**

---

### Shares are exempt from the reap

**When** — `484f4ab8`.

**The choice.** Apps, agents and publishes are deleted when their folder goes.
Shares are not: a share is an agreement between two workspaces rather than a
thing on this drive, and it already has its own rail that unlinks on the same
evidence.

**The gap.** "The thing is gone" doesn't enumerate which things.

**The reach.** Two rails now react to the same signal for different row types.
If they ever disagree, this exemption is where to look.

**Verdict — sound.** Deleting one side of a two-party agreement from a
filesystem observation would be the wrong authority.

**Confidence — high.**

---

### A replica goes out through the replica rail, not an origin teardown

**When** — `00822d4a`.

**The choice.** A *replica* is this workspace's copy of an app someone shared.
When its folder vanishes, the row must go — the delete dialog promises exactly
that in words.

I first skipped replicas entirely, reasoning the share rail owned them. It owns
some: a replica sitting exactly at the share's mount point shares the mount's
anchor. One nested any deeper owns its own anchor and fell through both rails —
stranded forever. That was a regression I introduced and then fixed.

Replicas now go out through the replica adapter rather than the origin teardown,
because a replica has no keys of its own to revoke and no copies of its own to
reconcile.

**The gap.** Which rail owns a replica whose folder disappears was never stated.

**The reach.** The adapter also deletes the anchor it owns, so the reap can no
longer assume an anchor survives its own teardown.

**Verdict — sound** (as corrected). Pinned by a test written against the
deeper-than-mount case specifically, and falsified against the skip.

**Confidence — high.**

---

### Test-only mutations moved off the production surface

**When** — `111a80b5`.

**The choice.** `markBroken` was a real, authenticated API whose only callers
were test fixtures. Moving it to the testing namespace required exporting two
internal helpers from the anchors module.

**The gap.** Housekeeping I chose while nearby.

**The reach.** Two functions that were private are now part of that module's
surface, in exchange for one fewer production endpoint.

**Verdict — sound.** A production surface no caller reaches is one that drifts.

**Confidence — high.**

---

Trivial discretion not listed: naming (`isDerivedContentPath`, `deleteAppRow`,
`anchorsUnderPath`), comment placement, and which existing test files new cases
joined.
