# Choices ledger — agentic-onboarding

Every decision made where the spec was silent, re-audited against the shipped
code at the close of the polish pass that followed slice 08. Ranked
least-confident-first: the things you may want to change sit at the top.

Verdicts: **your call** (a real product choice made without you — a
provisional call is in place so the build never blocked) · **judgment**
(defensible either way; the reasoning is here) · **settled** (follows from
the spec or repo practice; listed so nothing is hidden).

---

## Your call — five things decided without you

**0. A tap now carries you forward on its own, after 280ms.**
Every single choice — a goal tile, a follow-up chip — advances by itself;
Continue survives only for going back and forth, for naming the assistant,
and for the team step, which is a multi-select with a floor. You asked for
"like 30ms"; under about 150ms the selection is gone before the eye
registers it, so the tap reads as the app skipping a step rather than
answering one. One constant, `SELECTION_ADVANCE_MS`.
*In place: 280ms.*

**0b. A goal backdrop was built and thrown away.**
Six animated canvas motifs — falling glyphs, a branching structure, expanding
rings — shipped behind the questions, then were deleted when the Duet avatars
arrived. Two answers to one question; the avatars won because they are made
of the product's own character rather than decoration around it. Recoverable
from git history, but the reason it lost is here rather than there.
*In place: deleted.*


**1. The step counter jumps from "of 4" to "of 5" when you pick a goal.**
The goal step doesn't know yet whether follow-ups exist — they only exist
for the six preset goals, not "Write your own" — so the total changes the
moment you tap a tile. The unprimed critique flagged it as the one
remaining oddity in the flow. Alternatives: pin it at "of 5" and skip a
number on the custom path, or drop the counter for question-level dots.
*In place: the honest changing count.*

**2. The Spanish copy is new translation, never reviewed by a human.**
All 40-odd goal, follow-up, and rail strings were written for es-419 in the
existing "tú" voice. Choices worth a glance: "Prospección en frío" for
outbound outreach, "Automatizar el trabajo repetitivo" for automate
busywork, "leads" and "CRM o helpdesk" kept as loanwords, "Meta:" as the
purpose prefix. English wording is pinned by golden tests; Spanish
deliberately is not, so you can reword it without breaking anything.
*In place: ships as translated.*

**3. Convex's generated type file was hand-edited, not generated.**
`packages/backend/convex/_generated/api.d.ts` gained two entries for the new
onboarding module written by hand in codegen's exact format, because no
worktree here has access to the Convex project to run `convex codegen`. The
next real `convex dev` or deploy regenerates and confirms it. It typechecks
and every test passes, but it is the one artifact in this feature that a
machine should have written.
*In place: hand-written entries; deploy will confirm.*

---

## Judgment calls

**The recommendation rail is all four or nothing — twice over.** The server
already collapses to zero when fewer than four picks survive validation. The
client now does the same when a pick's agent has vanished from the catalog
between the server's read and the render: rather than quietly showing three,
the whole rail disappears and you get the plain catalog. Reasoning: a short
rail is exactly the broken-looking half-answer the four-or-nothing rule
exists to prevent. Found by the final review; it needs a marketplace
unpublish in a several-second window to trigger at all.

**A failed recommendation stays failed for that purpose.** If the call fails
or times out, the rail never appears and does not retry — even though the
catalog beside it has a Retry button. This follows the settled "silently
never appears on failure" decision, but it means a transient blip costs that
user their personalization for the whole session. Cheap to change later if
you'd rather it retried.

**Re-picking the goal you already picked does not reset your answers.**
Otherwise going Back to the goal step and tapping the same tile would wipe
chip answers you had edited. Returning to follow-ups resumes at the question
you left.

**The purpose is composed from the localized labels you actually tapped**,
not from canonical English — so a Spanish user's stored purpose is Spanish,
and the model is instructed to answer in the same language. This is why the
server stores opaque text and never learns a goal id.

**"Goal label lowercased" is smart, not blunt.** Only a plainly-capitalized
first word gets lowered, so the composed sentence reads "Goal: improve my
marketing & SEO" and "Business: B2B services" rather than mangling SEO, B2B,
and CRM.

**Analytics gets the goal id, never the purpose text.** `onboarding.completed`
carries `goal: <goalId>|'custom'|'none'`. The stated reason someone gives at
signup is not analytics payload.

**The minimum-3 floor is UI-only and fails open.** `requiredTeamSelections`
is its single owner: three when the catalog is healthy, zero when the
catalog is loading, errored, or thinner than three. The server still accepts
`skip` and fewer, which is what keeps the two existing API-level staging
journeys valid — and what stops a marketplace outage from dead-ending
signup.

**The recommendations endpoint closes when onboarding does.** Owner-only,
and 409 once `onboardedAt` is set, so a platform-paid LLM call can't be
farmed as a general-purpose endpoint afterwards. No rate limiting yet.

**The model is asked for 140-character reasons but the wire accepts 200.**
Deliberate headroom so a slightly-long reason arrives intact instead of
being cut mid-sentence. Both numbers now come from named constants.

**The local e2e permanently exercises the failure path.** Local Convex has
no gateway key, so the recommendations call always returns empty there — by
design, the fallback gets the strongest regression coverage, and the live
path is the staging journey's job.

---

## Settled — recorded so nothing is hidden

- One shared base schema (`duetName`, `purpose?`, `goal?`) under both
  branches of the onboarding request union, rather than the fields added
  twice.
- `purpose` is write-once, by the same mutation and the same rule as
  `duetName`; the recommendations endpoint never persists anything, so an
  abandoned onboarding leaves no trace.
- The recommend action reuses the marketplace catalog query and its response
  schema — no second catalog projection — and filters to verified publishers,
  the same rule the team step applies.
- Once the endpoint's guards pass it always answers 200 in the response
  shape; transport failures included. The client has one shape to handle.
- Recommendation validity is enforced on both sides: the action validates
  names against the catalog, and the client collapses the rail if a pick has
  since left it (see the four-or-nothing judgment call above).
- Reducer owns catalog state, goal mode, seeded answers, follow-up index,
  and recommendation state, so every UI state is reachable from
  `initialState` in tests.
- `partitionCatalog` lives beside `TeamStep`; `MarketplaceAgentGalleryCard`
  gained an optional `reason` slot instead of being forked — the marketplace
  surface shares that card and its baselines stayed byte-identical.
- Chip ids are stable kebab slugs; the `"Goal: "` prefix is itself a
  translated key.
- The knowledge step's helpers (`onboarding-website-field`, `onboarding-url`)
  were deleted a slice earlier than planned because the visual-coverage gate
  red-gates orphaned components.
- Dead config vocabulary (`secondaryAction`, `getOnboardingStepConfig`,
  `getOnboardingStepIndex`) removed with its last user.
- The e2e seeds all 21 official agents and asserts a non-empty catalog rather
  than a fixed count; it pins the local `pull_failed` install degradation
  (no VM locally) and asserts installs at the subscription-results level.
- The e2e's expected purpose is computed through the shipped composer, so it
  pins the wiring rather than the copy.

---

## Two findings that outlived the build

**The avatar files are not named after the goals they belong to.** Two of the
original six differed (`better-research`→`research`,
`content-faster`→`create-content`), so `onboarding-avatars.ts` carries an
explicit map rather than a template string. A template would have 404'd
silently on exactly those two. The map earned itself again on the cut to three
goals: the surviving props were renamed under the new ids, and the two that
had no prop of their own inherited one (`launch-project` wears the rising
arrow, `replace-software` the checked clipboard) — a stand-in the map makes
visible instead of hiding.

**The live probe caught a real bug before any user could.** Running six
sample purposes against the real gateway showed `gpt-5.4-mini` reading "in
the language of the user's goal" as licence to answer English purposes in
French. The instruction now names the rule by example. Median latency 1.8s
against a 10s budget.

**The docs endpoint-coverage ledger silently drifted** when the new route
landed, which would have failed the repo-wide gate. Regenerated. Worth
knowing: adding an endpoint requires `bun run endpoint:coverage:write`.

**The repo-wide gate is red, and none of it is this feature.** Six failures,
verified by checking out clean `origin/staging` (including the latest pull)
in a scratch worktree and reproducing them there:

- `billing overview keeps a downgraded workspace denominator physically honest`
- `billing overview reports independent newest measurements for Max workspaces`
- `credits ledger core > reservation reference replay stays idempotent…`
- `model gateway ledger reconciliation > member activity debits the designated payer…`
- `api v1: auth and devices > auth filters stale scopes after slug reuse and role demotion`

All five reproduce on clean staging with none of this work applied. A sixth,
`VM register drains provisioning agent turns in order exactly once`, **passes
in isolation** on this tree and fails only inside the full run — contention,
not a defect. Every onboarding-owned test passes: 64 web, 21 api, 14 backend,
497 contract, 3 harness, plus the local e2e.

The auth failure looks like a real regression (deterministic
`workspace_limit_reached`, plausibly from the vm-compute-fees workspace
limits) and has been raised as its own task.
