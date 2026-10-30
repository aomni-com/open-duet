# Choices — archive default chat

Decisions made on your behalf that were **not** in [`MAP.md`](./MAP.md).
D1–D11 are not here; you made those before the build.

Grouped by verdict, least-confident first inside each group. Every entry stands
alone — you should not need the diff, the spec, or the transcript to judge it.

**Review these three first**, whatever their group: the control's affordance
(#1), the 18 stale baselines I chose not to touch (#2), and the unrelated
screenshots that rode into the feature commit (#3).

---

## Needs your call

### 1. The button looks like a label, because you asked for it to be quiet

**When:** `747c53781`, and the visual pass after it.

**The scenario.** You open `brand-designer`. Under the agent's name there is a
row of three bordered pills — Train, Settings, Jobs. Below that is a panel whose
top line reads `CHAT` in small grey uppercase letters. At the right-hand end of
that same line now sits `⊟ Archive default chat`.

Here is what an unprimed reviewer found: `CHAT` and `Archive default chat` are
drawn in **exactly the same colour, size and typeface**. Both `.km-eyebrow` (the
static label) and `.km-chat-act` (the button) resolve to `color: var(--km-dim)`,
`font-size: 11px`, `font-family: var(--km-mono)`. They differ only in that one is
uppercase with wide letter-spacing and the other is sentence case. The button has
no border, no fill, no underline. It only announces itself on hover, when it
darkens.

So the one clickable thing in that row is the only control on the page with no
visual affordance — "affordance" meaning a cue that says *this responds to a
click*. Every other action on screen is a bordered pill.

**What the alternative would look like.** One line of CSS giving `.km-chat-act`
its own resting colour, a step stronger than the eyebrow's — still no border,
still no pill, but no longer literally the same ink as the inert label beside it.

**The gap.** D7 settled the *weight* ("icon + text, not a glass plate") but not
the *contrast against its neighbour*. Nobody asked what happens when a quiet
control sits beside an equally quiet non-control.

**The reach.** This is the first control ever placed in a `SectionHead`. Whatever
it looks like becomes the pattern for the next one.

**Verdict: needs-user.** Taste, sitting directly on a decision you made, so I did
not override it. **Provisional call in force:** left exactly as specified — same
ink as the eyebrow. Reversible with a one-line colour change in
`knowledge-map.css`.

**Confidence: low** that you'd have chosen identical ink had the question been
put to you in these terms.

### 2. The visual suite is red on `main`, and I left it that way

**When:** the visual pass — deliberately *not* committed.

**The scenario.** The repo has a screenshot suite: it renders each UI fixture in
a pinned browser and compares the result against a committed PNG (a "baseline").
I ran the whole web suite with `PLAYWRIGHT_MAX_FAILURES=0` — meaning *don't stop
at the first failure, run everything*. The default in `playwright.config.ts:6` is
`maxFailures: 1`, so normally the suite aborts the moment one shot fails and
every shot behind it is never attempted.

Run fully, **18 shots failed**. To find out whether that was my doing, I exported
the untouched `HEAD` commit into a clean directory with `git archive` and ran the
identical suite there. Same 18.

I traced one to its root. `settings-default-tier-free` differs from its baseline
in exactly one place: a small money meter the baseline draws as `$ 5/5` and the
live app draws as `$ 1/5`. The commit `606d677e7 feat(tiers): the dollar meter
reads as price, not efficiency` changed what that meter means — a cheap tier used
to score 5/5 for efficiency and now scores 1/5 for price. That commit never
re-approved this screenshot, and **no commit has touched that PNG since**. It has
been silently wrong ever since, and `maxFailures: 1` is why nobody noticed: the
suite was quitting before it got there.

**What the alternative would look like.** Re-approve all 18 here. My commit would
then carry roughly thirty extra PNGs unrelated to archiving a chat.

**The gap.** The map planned for the baselines *this feature* moves. It never
imagined the suite was already failing.

**The reach.** Until these are fixed, nobody can distinguish a real regression
from standing noise — which is how #3 below nearly slipped past me.

**Verdict: needs-user.** **Provisional call in force:** left untouched and
documented, because burying a real finding under thirty unrelated screenshots
makes this branch unreviewable. Reversible with one `ui:approve --force` run. The
companion fix is raising `maxFailures` so a suite that aborts early stops hiding
the rest.

**Confidence: medium** — you might reasonably prefer them swept now.

### 3. Twenty-five screenshots changed in the feature commit; my change explains about ten

**When:** `747c53781`.

**The scenario.** Screenshot comparison has a tolerance: a difference below the
threshold passes. Tiny rendering shifts therefore accumulate in a baseline
without ever failing. The normal approval command (`--update-snapshots=changed`)
rewrites only files whose diff exceeded the threshold; the `--force` variant
(`--update-snapshots=all`) rewrites **every** matched file whether it failed or
not.

I had to use `--force`, because the normal path had left a baseline stale — see
#4. But `--force` also flushed all that accumulated sub-threshold drift at once,
so the commit contains rewritten PNGs for shots my change cannot affect:
`knowledge-map-empty`, `knowledge-map-home`, and the `agent-surface-setup-*`
family (setup mode does not render the CHAT header at all).

This is documented repo behaviour — a previous spec records that "`--force`'s
first application is not a no-op even on an untouched shot."

**What the alternative would look like.** Revert the PNGs my change can't
explain, keeping the commit tight — at the cost of leaving that drift to
accumulate and surprise the next person.

**The gap.** The map costed "re-approve the baselines" without noting that the
only reliable approval path also rewrites neighbours.

**The reach.** Anyone bisecting a future visual regression through this commit
sees ~15 screenshots move for no stated reason.

**Verdict: needs-user.** **Provisional call in force:** kept, since flushing
drift is the documented intent of `--force` and reverting re-arms the same trap.
Reversible with `git checkout 747c53781^ -- <those paths>`.

**Confidence: medium.**

### 4. `--update-snapshots=changed` left a baseline stale, and the checker passed against it

**When:** the visual pass.

**The scenario.** After wiring the control into the playgrounds, I ran the normal
approval. It rewrote the **mobile** `agent-surface-busy` baseline but not the
**desktop** one — even though the desktop render had gained a labelled button,
which is nowhere near the pixel threshold. I then ran the checker on that fixture
and it reported **2 passed**, comparing the new render against the un-rewritten
file.

I only caught it because the desktop baseline visibly lacked a button the mobile
one had. `--force` regenerated it correctly.

**The reach.** A green screenshot run is not proof the baselines match the
render. This is #2 seen from the other side; together they say the
changed-only approval path is not trustworthy in this repo.

**Verdict: needs-user** — you own whether to trust that path in future.
**Provisional call in force:** I force-regenerated the whole affected family from
a clean build rather than trusting the incremental path.

**Confidence: medium.**

### 5. I widened which directories `apps/web`'s test command runs

**When:** `747c53781`.

**The scenario.** `apps/web`'s `test` script listed the folders to search:
`bun test ./scripts ./app ./src ./spa`. The web lane put its new test for the
playground's fake API in `components/playground/spa-fixture.test.ts` — beside the
thing it tests, per repo convention. But `./components` was not in that list, so
the package's own gate would never have run it. Two other test files under
`components/auth/` had been orphaned the same way.

**What the work does today:** the list includes `./components`. All ten tests
across the three newly-reachable files pass.

**The gap.** The map said "add tests"; it did not say where they may live.

**The reach.** Two previously-dormant suites now gate. If either becomes flaky,
it blocks the package gate.

**Verdict: needs-user**, only because it changes a gate rather than the feature.
**Provisional call in force:** kept — a test that never runs is not a test.
Reversible by deleting one word.

**Confidence: high** that you want it; flagged because gate changes deserve to be
seen.

---

## Sound

### 6. One workspace-wide timestamp perturbs every agent's cache key

**When:** `747c53781`.

**The scenario.** The trap first. When you type the first message into an empty
chat, the browser sends it and the server replies with a brand-new session id.
The panel holds that id in state called `created` and shows it **in preference
to** re-asking the server, so the conversation you just started doesn't blink
away while the server catches up. `created` is stamped with an "owner key" — a
string identifying which agent it belongs to — so flying to another agent doesn't
mount agent A's id on agent B's panel.

Archiving breaks that: afterwards the server's answer ("there is no default
chat") is *newer* than the held id, but the held id still wins. The person who
started the chat in that tab would keep reading the conversation they just
archived — no error, no spinner.

The fix folds the archive moment into that same owner key. The route keeps a
timestamp, `chatArchivedAt`, set when an archive succeeds, and the key becomes
`${workspace}/${agentSlug}/${archivedAt ?? 0}`. After archiving the key changes,
the held id no longer matches, and the empty chat returns.

**The choice I under-reported:** `chatArchivedAt` is a **single** piece of state
for the whole map, not one per agent. Archive agent A's chat and that timestamp
also lands in agent B's key the next time you open B.

That is harmless **today**, for exactly one reason: the chat panel is mounted
with `key={\`chat:${agentScope}\`}` (`agents-map.tsx:1029`), and changing a React
`key` destroys and rebuilds the component — which wipes `created` anyway. So B
never has a held id to mis-invalidate.

**The reach.** That safety is load-bearing and undeclared. The module's own
comments contemplate an unkeyed instance; if anyone removes that `key`, archiving
one agent starts perturbing every other agent's cache key. Making `chatArchivedAt`
a per-agent record would remove the dependency.

**Verdict: sound** — correct today, and the alternatives (a callback, or lifting
`created` out) were more invasive. **Confidence: medium**, purely because of the
hidden dependency.

### 7. The archived thread keeps its old system prompt forever, and we shipped that

**When:** `747c53781` — your decision (L2), banked because it is the largest
behavioural gap in the feature.

**The scenario.** Each session runs on a long-lived virtual machine. When Duet
sends a turn there it includes a "launch" record. If the session is the owner's
default chat, that record carries `defaultSession: true`, and the machine writes
an extra instruction file into the agent's system prompt saying, among other
things, *never create a state machine here* — i.e. "this is a conversation,
delegate real work elsewhere."

Duet recomputes that flag from the pointer on **every** turn and correctly stops
sending it once you archive. But the machine merges each new launch record over
the stored one, and **an absent key deletes nothing** — only one field in that
merge (`integrations`) is explicitly cleared when missing. So `defaultSession:
true` survives in the stored record forever.

Concretely: after archiving, the thread is an ordinary job everywhere you can see
it — in Jobs, with a normal bucket, nothing deleted. But on the machine it still
believes it is the default chat, and if you reply in it, it will still refuse to
start a state machine.

The one-line fix is written out in `MAP.md`.

**Verdict: sound** as a decision — you chose it, and it only bites on the
uncommon path of continuing an archived thread. **Confidence: high.**

### 8. The playground fake stores a pointer now, which changes shared test data

**When:** `747c53781`.

**The scenario.** The screenshot playground runs the real UI against a fake API
so no server is involved. That fake had no notion of a stored default-chat
pointer: it *computed* the answer as "the first session belonging to this owner."

That computation cannot express the state this feature creates — an owner whose
pointer has been cleared. "First session belonging to this owner" always returns
something. A fake that cannot represent the state under test cannot fail on it.

So the fake now holds a real pointer, seeded from that same "first session" rule
so nothing shifts on day one, and — matching the real server — **stamps the
pointer when the alias mints a session**.

**The consequence you own:** in the fake, creating a session through the alias
now makes it that owner's default and therefore hides it from the jobs list
(which excludes the default chat). That is what the real server does. But it is
shared fixture data many unrelated scenes read, and I confirmed it broke none of
them only by running the suite.

**Verdict: sound** — a fake that lies toward "everything passes" is worse than no
fake. **Confidence: high.**

### 9. Three writers of the pointer became one

**When:** `747c53781`.

**The scenario.** "Which session is the default" is a single field on the owner's
row — `agents.defaultSessionId` for an agent, `workspaces.rootDefaultSessionId`
for the drive itself. Two places already wrote it: sending a first message stamps
it, deleting a session clears it. This feature adds a third.

Each place separately knew the rule *root uses the workspace column, an agent
uses the agent column*. Three copies of one fact drift apart. They now all call
one function, `writeDefaultSessionPointer`.

**The gap.** The map only said "don't duplicate delete's clear."

**Verdict: sound**, and better than asked for. **Confidence: high.**

### 10. A shared error translator learned one more word

**When:** `747c53781`.

**The scenario.** The database layer throws plain text; the HTTP layer maps that
text to a status code. A helper did this for session routes, living privately
inside one route file. The new route needed the same mapping, and importing it
from there would have created a circular import — so it moved to the shared
module, and gained one pattern: an error containing `mismatch` now returns **404**
instead of falling through to a 500.

That matters because pointing the alias at a session belonging to a *different*
agent throws `Default session owner mismatch`. From the perspective of the agent
in the URL, that session simply isn't one of theirs — a miss, not a crash.

**Why this is safe, checked rather than assumed:** the helper has seven call
sites, and the only `mismatch` errors any of them can produce are the two
`Default session owner mismatch` throws. The other `mismatch` errors in the
codebase (`Confirmation mismatch`, in admin routes) are on routes that never
touch this helper.

**Verdict: sound.** **Confidence: high.**

### 11. The disabled rule reads the mutation registry instead of a prop

**When:** `747c53781`.

**The scenario.** The button must be dead while a first message is in flight,
because that message ends by stamping the pointer — archiving underneath it would
clear a pointer about to be rewritten, and the conversation would reappear.

But the send lives *inside* the chat panel and the button is drawn by the surface
*around* it. Rather than thread a flag up through the layers, the send was given
a named key in the repo's typed mutation registry, and the button asks the query
library "is anything with this key running right now?"

**Verdict: sound** — no new state, and the two cannot disagree.
**Confidence: high.**

### 12. Documentation that was already wrong got fixed in passing

**When:** `747c53781`.

The public docs said reading the default-chat alias before any message *"returns
`no_default_session`"*. It does not, deliberately: it returns `{"session": null}`
with a **200**, because browsers log every 4xx to the console and a fresh
workspace was painting a wall of phantom errors on load. Only `/history` returns
`no_default_session`.

I was already rewriting that paragraph to describe the new `PUT`, so I corrected
the claim and made it describe the alias per-owner rather than as a drive-only
thing.

**Verdict: sound** — a wrong comment outlives the diff that would have fixed it.
**Confidence: high.** Trivially separable if you want it as its own commit.

### 13. The API refuses an owner the read forgives

**When:** `747c53781`.

`GET …/sessions/default` for an agent that doesn't exist answers
`{"session": null}` and a 200, folded into its ordinary "no chat yet" answer on
purpose. The new `PUT` does not: an unknown or unlaunchable agent gets a 404, a
malformed body a 400. Reporting success for a write against something that does
not exist would be a lie.

**Verdict: sound.** **Confidence: high.**

### 14. The endpoint is reversible on the wire and one-way in the product

**When:** `747c53781` — your call (D5), banked because it leaves unused surface.

The route takes `{ sessionId: string | null }`. The product only ever sends
`null`. Sending an id re-points the alias — a capability no UI exposes and
nothing in the codebase calls. It is declared `idempotent: true` and answers with
the same body the `GET` does, so clearing reads back `{ session: null }`.

**Verdict: sound** because you chose it explicitly. **Confidence: high.**

### 15. The mutation takes no injectable clock

**When:** `747c53781`.

Every sibling session mutation accepts a `now` parameter so tests can pin time.
This one writes a single pointer field and no timestamp, so accepting a `now` it
ignored would be a lie in the signature.

**Verdict: sound.** **Confidence: high.** One line to add back.

### 16. The Spanish button says something slightly different from the English one

**When:** `747c53781`.

English reads `Archive default chat`; Spanish reads `Archivar este chat` —
literally "archive *this* chat". Two reasons: ~28 characters of monospace would
crowd the narrow column, and Spanish is the widest shipped locale and the one
that decides whether the row fits; and it matches the Spanish dialog title,
`¿Archivar este chat?`.

**Verdict: sound**, though it is a genuine wording difference and not merely a
shortening. **Confidence: medium.**

### 17. The control got its own style rather than reusing the doors'

**When:** `747c53781`.

The three header pills use a class that draws a bordered glass plate. D7 rejected
a plate here, so the control has its own class at the header's own size and
line-height, with the label truncating and the icon never shrinking — which is
what keeps the row from pushing the panel wider than the column it lives in.

**Verdict: sound.** **Confidence: high.**

### 18. Trivial discretion, not itemised

Internal naming (`chatAction`, `defaultChatArchivedAt`, `ArchiveDefaultChatAction`),
where the confirm dialog is mounted in the component tree, rendering the failure
inside the dialog with a retry rather than as a toast, and committing the feature
and its follow-up test as two commits rather than one. **Sound, high confidence.**

---

## Corrections to my own reporting during the run

Two claims I made that were wrong, corrected here so the ledger isn't built on
them:

- I said `bun ui:approve` had been broken repo-wide since `29162fe3a` because
  `[[ cond ]] && cmd` aborts under `set -e`. **It does not** — bash exempts a
  failing command on the left of `&&`. I reverted the change made on that
  premise; `ui-visual-preflight.sh` is untouched.
- I twice called the remaining visual failures flaky after sampling a run before
  it finished. They are deterministic; the pristine-`HEAD` comparison in #2 is
  the real answer.

---

## Pre-existing failures found while gating

**A billing test became a time bomb — found here, fixed here (`8705f15bd`).**
`packages/backend/src/billing.test.ts` — *"acknowledging a low-credit warning
persists it for the current subscription period"* — asserts against a recorded
Stripe payload whose subscription period ends at epoch `1786977791000`, i.e.
**Mon 17 Aug 2026 14:43 UTC**. Every answer it checks depends on whether "now"
falls inside that period, and it read the wall clock. So it passed until the
period elapsed and then failed permanently: the subscription reads inactive, no
warning is persisted, and the assertion gets `null` where it expects an object.
It failed identically when run alone, so it was not the usual under-load
flakiness — it had simply expired, about eleven hours before this run.

The fix pins the clock inside the fixture's own period for both the overview
read and the acknowledge mutation. The mutation needed it too: it refuses an
acknowledgement that does not name the period current at its own `now`. The
query already accepted an injectable clock; the test helper did not pass one.

Unrelated to this feature, and committed on its own.

**The root suite's failure count is load-dependent.** The full `bun run test`
reported 3 backend failures and an `apps/api` failure. Re-running each package
alone: backend 1 failure (the billing time bomb, now fixed), `apps/api`
**526 pass / 0 fail**. The other three did not reproduce.

## Left alone deliberately

- **L9, L10, L11** from the map — sharp edges, unchanged.
- **A pre-existing fake-API bug:** the playground's fake throws 404 for a first
  message into the drive's own chat, because it accepts a different token for
  "root" than the real client sends. Fixing it changes what a scene draws.
- **A pre-existing missing translation:** `duetApp.sessionProduct.taskPlaceholders`
  has no `es-419` entry.
