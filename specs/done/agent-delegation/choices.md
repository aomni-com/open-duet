# Choices — agent-delegation (consolidated)

Every decision made where the spec was silent, re-audited against the shipped
code at close. Grouped by verdict, least-confident first. This is your review
surface for what was decided without you; gates, evidence and journey results
live in the README and slice files, not here.

---

## Needs your eyes

### 1. The old root URLs return 500, not 404 — left that way

We deleted `/v1/ws/{ws}/agent/sessions/default*`. Anyone still calling those
paths gets a server error, not a clean "not found": with the literal routes
gone, the word `default` falls through to the `{sessionId}` route patterns, and
the database rejects it as a malformed id. This is pre-existing behaviour for
*any* malformed session id (`/agent/sessions/notanid/...` does the same), so a
stub route returning a tidy 404 would have been compatibility scaffolding for a
route we deliberately killed. **The underlying defect — malformed session ids
500 on every session route — is real, unfixed, and not this feature's.**

### 2. Two pre-existing surface defects found by the unprimed critique, not fixed

The fresh-eyes pass on the agent-surface shots found: the "sessions wall"
fixture state renders no visible wall (it looks identical to the normal state),
and the mobile surface is a squeezed desktop — clipped tab strip with hidden
apps, a ~100px chat column, touch targets under 44px. Both predate this
feature and sit outside its one visual variable, so they were recorded, not
repaired.

### 3. A transport question left open: long waits may be cut at ~4.5 minutes

One kill-gate run had its connection severed at 268s — short of the 720s server
ceiling and the 780s client abort. The passing run (112s) proves this feature
never gets near it, not that the cut is gone. If any future wait needs more
than ~4.5 minutes, expect it back. The probe's four-run story is recorded in
the README's dead-ends section; nothing in this feature blocks on it.

---

## Decided, with reasons — the calls most likely to interest you first

### 4. The ask-answer leg was shipped unattributed, then fixed before deploy

The first rendered recipe posted the answer to a child's question *without*
`sourceSessionId`. A VM credential resolves to `kind:"system"`, so the answer
would have arrived stripped of the caller's identity — and the journey's own
assertion would have failed on the live run. Caught by the pre-ship branch
review; the answer block now carries the same attribution as the task and its
own 202-retry loop (it previously said "retry the identical request" while
discarding the body it would need to do so).

### 5. D4's locked flag reads `agent.json` from the gateway (your fallback untaken)

You authorised "hide locked agents" if the read proved complex or slow. It was
neither: ~31 small file reads per turn against a turn that already spawns a
process, using `resolveAgentConfig` (already fail-open by design) and the same
symlink containment as the authored prompts. Locked children are listed and
flagged, exactly as D4 wanted.

### 6. The default-chat owner became a token; `null` no longer means root

The cutover initially kept the web's `null`-means-root spelling, translating at
the URL builder. Your "why both?" review exposed a `'root' → null → 'root'`
round trip, and the last real consumer of the null (the browser-side default
route) had just been deleted on staging. The owner is now a plain string end to
end, with `ROOT_AGENT_SCOPE` as root's name — the same token the job filters,
the session picker and `PATCH /agents/root` already used.

### 7. `ROOT_AGENT_SCOPE` moved into the slug module

Referencing the reserved slug from the contract's agents module would have
created an import cycle (`sessions` already imports `agents`), and the slug
module was already dodging that cycle by spelling `'root'` literally with an
apology comment and a drift-pin test. The constant now lives beside the
reservation it names; the pin dance is gone; external imports (all via the
barrel) were unaffected.

### 8. The map's hierarchy is computed inside the projection

Slice 07 sketched a `visibleAgentIds` parameter threaded in by the caller.
Implemented instead with the hierarchy computed inside `projectWorkspaceMap`
from the slices it already holds — the projection stays the single slice→map
owner, and no caller can hand it a ring that disagrees with the rule. The
caption in the hook calls the same owner a second time: two calls, one owner,
no drift.

### 9. Composed envelopes are enriched; durable history stays id-only

Slice 02's `agent_slug`/`agent_name` exist only in the model-visible bytes,
resolved fresh per delivery. The api tests that pin gateway payloads gained the
enrichment; the tests that pin durable timeline rows deliberately did not —
history stores identity, and names are resolved at read time so a rename shows
up everywhere at once.

### 10. Backend `agentDisplayName` moved to a leaf module, not the contract

The topology projection (anchors domain) needs the name rule, but agents/model
imports anchors/model — a cycle. The web's copy carries a comment deliberately
rejecting a contract-level display adapter ("naming is presentation"), so
unifying all three would re-litigate that. The backend rule sits in
`domains/agents/display.ts`, below both domains; the web keeps its own.

### 11. Roster freshness is poll-bounded, not push-fresh

A rename or new agent reaches sibling prompts on the next VM sync (~5s active),
not instantly. The alternative — widening the synchronous anchors push into a
topology push — was drafted, recorded in the README, and deliberately not
taken: the prompt regenerates every turn, and nobody can perceive seconds of
roster lag in a conversation. If staleness is ever *observed*, that is the
change to make, and the projection is already the right shape for it.

### 12. The one-layer scoping is also the deadlock guard — never widen it casually

`follow_up` into a session that is blocked waiting on you hangs both sides;
the roster's reply rule (end your turn by asking) and the one-layer visibility
are what make the A→B→C→A cycle unaddressable. `parent-session.md` — whose old
recipe *was* this deadlock — is narrowed to the idle-parent case. Any future
"let root see the whole tree" request reopens this.

### 13. The cold read reshaped the prose before it shipped

An unprimed agent handed only the rendered samples produced the correct call
sequence — and three trip points, all fixed and pinned: the answer leg's
under-specified retry, the unnamed ask payload (`terminal.event.questions`),
and a leaf scope that said "No agents are registered" then "Hand one of THEM a
task". The recipe's example slug now prefers an unlocked child.

### 14. The kill-gate probe was deleted once its condition was met

It answered its question (112s vs the 720s ceiling), and after the route
cutover it targeted URLs this same branch deleted — run today it would have
failed for the wrong reason and read as a delegation regression. The README's
dead-ends section carries the durable record of what it measured.

---

## Repairs beyond the feature, made in passing

- **A stale visual baseline healed:** the committed agent-surface shot predated
  url-map's removal of the open-app arrow, kept green ever since by
  sub-threshold tolerance; the re-capture corrected it.
- **An env-coupled edge test pinned:** `FORCE_COLOR` from the parent shell
  reached a spawned node and wrapped the asserted stdout in ANSI codes; the
  spawn env now pins colour off, since the test is about module resolution.
- **Five unused imports** left by staging's api-test reorganisation, removed.
- **The docs endpoint ledger** regenerated after the four route deletions.
- **`your-apps.md`'s false freshness claim** ("when the session started")
  corrected — the file is rebuilt every turn.
- **Formatter drift** across ~30 untouched files, landed as its own commits so
  the feature diffs stay reviewable.
