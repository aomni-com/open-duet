# Choices ledger — hub-content-sync

Decisions made on your behalf that weren't in the spec, re-audited against the
**final shipped code**. Grouped by verdict, least-confident first inside each
group. Every entry stands alone — you shouldn't need the diff or the spec.

**Review these first:** #1 (the whole tree now ships as one JSON body, which
trades one growth ceiling for another), #2 (I reverted a fix the spec told me to
make), #3 (two test-only functions now live in deployed backend code).

---

## Sound — but you now own these

### 1. The whole managed tree ships as one base64 JSON body

**Confidence: low-medium.**

**What happens today.** You press *Sync from repo*. The API loads all 18
official-agent files, base64-encodes each one (base64 is a way of writing raw
bytes as plain text so they survive inside JSON — it costs about 33% extra
size), puts them all in a single JSON request, and POSTs that to the hub's VM.
The VM decodes each, compares it to what's on disk, and writes only what
differs.

**What it replaced.** Before, the API sent one HTTP request *per file* — 18
sequential uploads inside a single serverless function call. That was a latent
timeout: the more official agents you add, the closer that loop gets to the
function's time limit.

**The trade I made without asking.** I removed a *time* ceiling and introduced a
*size* one. There is no body-size cap on the new route, and the request holds
every file at once, inflated by a third. Today that's ~72KB of content, so it's
nowhere near anything. But an official agent shipping a large asset — a sample
dataset, an image, a bundled model file — makes one request carry all of it.

**The unbuilt alternative.** Chunk the tree into several requests (say 5MB
each), or have the VM pull the archive itself instead of receiving a push.

**The gap:** the spec said "one request replaces N" and left the encoding and
the size question entirely open.

**The reach:** this is the shape any future "push content to a VM" work will
copy. If the official roster grows past a few megabytes, this is the first
thing that breaks, and it breaks the whole sync at once rather than one file.

**Why sound anyway:** the failure is loud (a rejected request, not silent
corruption), the current margin is ~100×, and chunking now would be building a
mechanism for a problem you don't have.

### 2. I reverted a fix the spec explicitly told me to make

**Confidence: medium.**

**Background.** Each official agent ships a small web app, and each app runs on
a port number. The manifest — the file listing which agents the repo owns — can
either name a port or leave it out. Leaving it out means *"assign one for me."*

**What the plan said.** The planning map and the slice both recorded a bug: the
code only compares the port when the manifest names one, so *clearing* a port
supposedly never took effect. Both told me to compare it unconditionally.

**What happened when I built it.** I made the change, wrote a test, and the test
failed — correctly. All three agents leave the port unset, so the stored value
(say 4321) is compared against *nothing*, which registers as a difference
**every single time**. Every sync would re-register every app and hand running
apps new port numbers.

**What ships:** the original check, untouched. A new test pins that ports stay
**stable** across repeated syncs. The map's claim is struck through so nobody
re-derives it.

**The gap:** the plan asserted a bug that didn't exist. I trusted it enough to
build it, and only the test caught it.

**The reach:** the map is otherwise binding, and a future agent is told to treat
it as given. This is the one place it's wrong, so it's marked in three places.

**If you disagree:** the real fix would be teaching the manifest to distinguish
*"no opinion"* from *"explicitly no port"* with a sentinel value. Nothing needs
that today.

### 3. Two test-only functions were added to deployed backend code

**Confidence: medium.**

**What happens today.** `convex/testing/workspaces.ts` gained two new
functions: one that lists the workspaces a user still owns, and one that runs
the billing reconciler on demand. The tests call them to set up and inspect
scenarios that would otherwise need waiting for a scheduled job.

**The thing worth knowing:** `convex/testing/` **deploys to production**. These
aren't excluded from the build. They're protected by an internal-key check —
the same guard every other function in that directory uses — so they aren't
reachable without the shared secret. But they exist in prod, and one of them
can delete-adjacent things (it lists workspaces so a caller can delete them).

**The unbuilt alternative.** A separate test-only deployment, or driving the
real cron and waiting.

**The gap:** the spec said the assertions needed a live-database harness and
didn't say how to reach the state they assert on.

**The reach:** every future live test of billing or workspace lifecycle will
reach for these. The directory already held ~15 such functions, so this follows
the established pattern rather than starting one.

### 4. The billing exemption is applied inline, not through a shared setter

**Confidence: medium-high.**

**What happens today.** Two places can mark a workspace *"Duet pays for this,
never pause it"*: workspace creation (which takes a flag) and the sync
(which patches the field then re-runs the reconciler). Each does it in its own
two lines.

**What the slice asked for.** A single shared setter function both call.

**Why I didn't.** The two callers share no logic — one passes a flag into a
creation path, the other patches an existing row. A helper wrapping a one-field
write plus a function call would have been a third name for something neither
caller actually shares.

**The reach:** if a third writer appears, build the helper then — the pattern
becomes real at that point rather than speculative.

### 5. The button's address changed, and the old one is gone

**Confidence: high, but it's user-visible.**

`POST /v1/internal-admin/official-hub/seed` → `.../sync`. The mutations behind
it renamed too (`beginSeed`/`completeSeed` → `beginSync`/`completeSync`).

**Why:** they no longer seed once, they converge every time. A name saying
"seed" would send a reader looking for one-time-setup semantics that no longer
exist.

**What this costs you:** any saved link, bookmark, or written runbook step
pointing at `/seed` now returns 404. Nothing inside the product used it — the
web app only ever called `/official-hub/access` — so nothing broke, but a
human's notes might.

### 6. The response says what changed, not what state it's in

**Confidence: high.**

**What happens today.** The endpoint returns `{ workspaceSlug, written }` —
which hub, and the list of files it actually wrote. An empty list is a real,
meaningful answer: *the hub already matched the deployed code*.

**What it replaced.** A status word (`pending` / `created` / `existing`). That
made sense when the sync could decline to run; it can't any more, so a status
would always say the same thing.

**Why it matters:** the invariant "the button never silently does nothing" is
only trustworthy if you can *see* what it did. `written` is that evidence.

**Also trimmed:** the response used to carry `workspaceId` and `publishId`.
Nothing read either — the button uses `written`, the live test uses
`workspaceSlug` — so both were removed during the review pass.

### 7. The bookkeeping table was renamed and three of its fields deleted

**Confidence: high — you prompted this one.**

`officialHubSeedRuns` → `officialHub`, dropping `createdAt`, `completedAt`, and
`publishId`.

**Why the name was wrong three ways:** there is exactly one row (always read
with a "there must be only one" query); it records no "runs" of anything; and it
stopped describing a seed the moment syncing became repeatable. What it actually
holds is *which workspace is the hub*.

**Why the fields were dead:** all three were written and never read.
`publishId`'s only reader was a helper this feature deleted; `completedAt`'s was
the short-circuit that made the hub un-updatable in the first place.

**Why no migration was needed** — and this is the part worth internalising: the
hub is found by its **slug** (`official-agents-hub`, a constant in the
manifest), never by this table. Renaming the table just empties it; the next
sync looks up the slug, finds the existing workspace, adopts it, and writes a
fresh row. Proven live: the run after the rename touched the same hub, the same
listing, and wrote zero files.

### 8. One out-of-scope path fails the entire request

**Confidence: high.**

**What happens today.** The VM checks that every file in the request sits inside
one of the declared agent folders. If even one doesn't, it rejects the whole
request and writes nothing.

**The alternative:** skip the stray file, write the rest.

**Why reject-all:** a caller that sent an out-of-scope path has a bug. Applying
half of a buggy request leaves the hub in a state neither the caller nor the
operator intended, and it's silent. Failing loudly means someone fixes the
caller.

**The subtlety that made this real:** the scope check runs *after* path
normalisation. `agents/alpha/../../escape.md` starts with `agents/alpha/`, so a
naive prefix check would wave it through. Normalising first means such a path
is refused before any comparison happens. A test pins this.

### 9. Live billing tests assert at a clock in the year 2100

**Confidence: high.**

**The trap.** A newly created account gets free trial credits. The test fixture
uses tiny fake timestamps (a few seconds after 1970), and at that moment the
trial hasn't expired — so the account *is* entitled, and the hub reads "active"
whether or not the exemption exists. An assertion made there passes no matter
what the code does.

**How I found it:** my first draft did exactly that. Two of three tests were
vacuous and only the third failing revealed it. All three now assert at a clock
after the trial lapses, and removing the exemption line turns all three red —
which is the only reason to believe they test anything.

**The reach:** any future test of billing state in this fixture has the same
trap. It's documented in the spec and in a comment above the constant.

### 10. Smaller calls, grouped

- The temp directory the VM writes through is derived inside the route factory
  rather than threaded through every caller — it's the same drive-local staging
  path every other gateway write already uses.
- The test asserting *"seeding an existing hub changes nothing"* was rewritten
  from scratch rather than edited. Its own comment documented the assumption
  this feature reverses; a patched version would have kept asserting the old
  contract in disguise.
- `bun run inspect` now prints what a sync would write, grouped by agent. It
  previously described a different archive format used by an unrelated code
  path, so it answered a question nobody was asking it.
- The live test creates **one** shared throwaway admin identity instead of two.
  Doing so surfaced a cleanup bug that could never have worked: the identity's
  auto-created workspace was never deleted, and the account can't be retired
  while it owns a live workspace.
- Formatter output on files this work didn't otherwise touch was reverted for
  most of the run, then committed once you called it — and the rule is now in
  the code-review skill.

---

## Needs your decision

**None.** The one item that would have qualified — automating the sync so a
deploy presses the button — you already decided when I surfaced that no
post-deploy hook exists and that PR previews share the staging database. It is
recorded as scope, not debt.

---

# Appended 2026-08-16 — the sync learns to retire agents

Example User's directive: "modify the sync button to also DELETE the agents that
aren't used anymore, so I never have to go in manually." The directive named
the outcome; these are the decisions that filled in the rest.

**Review these first:** #A1 (retirement skips the runner-teardown discipline
the ordinary delete route insists on), #A2 (a big manifest purge runs as one
Convex transaction).

## Sound — but you now own these

### A1. Retirement deletes rows first and never tears down runners

**Confidence: medium.**

**What happens today.** When a user deletes an agent through the product, the
API is deliberately paranoid about live work: it first asks the workspace VM's
gateway to kill any running agent processes ("runners") under that agent, and
only if that succeeds does it delete the database rows — if the VM is
unreachable it refuses with a 502 rather than orphan a live process. The sync's
retirement does NOT do that leg. It deletes the rows inside the Convex
transaction, then best-effort deletes the folders; no runner teardown at all.

**Why I chose it.** Hub agents exist to be listed, not to work — nobody chats
in the golden workspace, so there should never be a live runner to orphan. The
row cascade still terminalizes any control-plane session records. And the sync
had already proven the gateway reachable earlier in the same request (the file
converge), so the fail-closed refusal would be protecting against little.

**The reach.** If the hub ever DOES run sessions (someone tests an agent in
place before publishing it), a retirement while a runner is live would leave
that process running on the VM until it exits on its own — annoying, not
data-corrupting. If that workflow ever becomes real, retirement should adopt
the delete route's gateway-first leg.

### A2. All retirements happen inside one Convex mutation

**Confidence: medium.**

**What happens today.** `completeSync` is a single Convex mutation (one
database transaction). The new retirement phase runs inside it: for every
agent the manifest dropped, it walks the agent's whole subtree — the agent
row, every app row under its folder, session records, its listing — and
deletes them, all in the same transaction that registered the survivors.

**Why it matters.** Convex transactions have a document-read ceiling (this
very file warns about it for another sweep). Retiring five agents is nothing;
retiring twenty agents each with apps and session history in one press could
hit the ceiling and fail the whole sync. Today's catalog is ~19 agents and
retirements come in ones and fives, so the ceiling is far away.

**The unbuilt alternative.** A per-agent retirement loop in the API route
(one mutation per retired agent). Slightly weaker atomicity, no ceiling risk.
Switch to that if a mass purge ever fails the sync.

### A3. A retired agent's listing is unlisted, never deleted or "removed"

**Confidence: medium-high.**

**What happens today.** Listings have three dead-ish states: `unlisted` (the
publisher pulled it; invisible in the catalog; can be revived by re-listing),
`removed` (an operator takedown; sticky — the sync explicitly refuses to
revive it), and actually deleting the row. Retirement sets `unlisted`.
Workspaces that installed the agent keep their copies working either way,
because installs are copies.

**Why.** `removed` is the takedown lever and should keep meaning "an operator
pulled this deliberately" — retirement reusing it would make the two
indistinguishable. Deleting the row would lose install history. And `unlisted`
makes restoration symmetric: re-add the folder to the repo, press sync, and
`registerListingImpl` revives the same listing row to `listed` — proven in the
integration test.

### A4. Only agents under the managed root are retirement candidates

**Confidence: high.**

**What happens today.** The sweep considers an agent for deletion only if its
folder sits under the hub's managed root (`agents/`), it isn't a replica
(shared in from another workspace), and its slug isn't in the manifest.
An agent someone hand-created in the hub OUTSIDE `agents/` would survive
every sync.

**Why.** This mirrors how the file reap has always been scoped: the manifest
owns its root, and claims nothing beyond it. It also means a stray experiment
in the golden workspace can't be silently vaporized by the next deploy.

## Trivial discretion

Roster read bounded by the shared `MAX_AGENTS_PER_WORKSPACE` constant; the
admin banner names retired slugs rather than counting them; `retiredAgents`
added to the public sync response schema (additive, non-breaking).
