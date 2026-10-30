# Hub Content Sync — shipped record

**Status: shipped to staging 2026-08-05 and green live.** The official-agents
hub is a replica the repo converges: agents named by
`packages/official-agents-seed/manifest.ts` are pushed onto the hub whenever an
internal admin presses **Sync from repo**, and every other agent in the hub is
left alone.

The decisions-made-where-the-spec-was-silent ledger is
[`choices.md`](choices.md). The planning walk is [`MAP.md`](MAP.md), kept as
provenance for *what was decided and why* — not as instructions, and corrected
where the build proved it wrong (see "Where the build diverged").

## What this is actually for

An **incubation → promotion pipeline**. Create an agent fast inside the
product, where iteration is instant and nothing needs a deploy. When it has
earned "official", move it into `content/` and add it to the manifest.

Promotion needs no mechanism, and that is the point of the design. Because
content syncs *into* the hub, an agent's slug never leaves the hub — so its
listing, its subscribers, and their installed copies are untouched by the move.
There is no promotion mutation, no origin switch, no re-consent, no cutover.
Subscribers see either a normal content update or nothing at all.

## Why this shape and not the obvious one

The obvious design was to stop using the hub workspace entirely and serve
official content from the deployed codebase — a `builtin` listing origin, a
reserved `/_builtin/<agent>?zip` path on the edge, per-agent zips generated at
build time. That was designed in full during the walk and rejected.

Syncing into the hub reaches the same authoring goal with **no second listing
origin, no marketplace schema change, and no cutover of live subscriptions**.
The rejected design's one real prize — official agents that cannot go dark when
the hub VM pauses — was bought separately and far more cheaply by making the
hub billing-exempt.

The cost, taken knowingly: the hub VM stays load-bearing for serving.

## Invariants — what must stay true

**The sync never skips.** Pressing the button converges the hub, every time.
There is no content hash, no "already current" verdict, no short-circuit. An
earlier draft gated the whole sync on a digest; it was overturned because a
button that sometimes silently does nothing is a button that lies. Comparisons
still happen — per file in the gateway, and per registration row in
`agentRegistrationDiffers` / `appRegistrationDiffers` — but none of them can
gate the sync itself; they only decide whether an individual write is
redundant.

**A byte-identical file is never rewritten.** The publish zip ETag is derived
from each entry's size and mtime, not its content (`zipTreeEtag`,
`packages/gateway/src/routes/files.ts`). Rewriting identical bytes rotates the
ETag, forces every subscriber to re-download, and flips their agent to
`update-ready` (`marketplaceSubscriptionHasUpdate`,
`apps/web/spa/marketplace/status-projector.ts`). This is why the comparison
lives on the VM holding the bytes, and why the live journey asserts a stable
ETag across two presses rather than trusting the reported write list.

**The sync reaps what the plan no longer claims** (changed 2026-08-11; it never
deleted when this spec closed). Under a root the request names, a path absent
from the request is removed — which is how a deletion or rename at the source
reaches the hub. Two bounds keep the original intent: the publish floor is never
reaped, so an agent's VM-installed `node_modules` still coexists with a
repo-owned folder; and a root the request does not name is never walked, so
dropping an agent from the manifest still means *stops being managed* rather
than *gets erased*. See `specs/done/default-agents/`.

**Takedown outranks the sync.** An operator who removes an official listing
stays in control of it; the sync skips listings in `state: 'removed'`. Without
this, making the seed repeatable would silently restore a pulled agent in front
of customers on the next press — the exact harm recorded as a reason a
predecessor feature was deleted (`specs/done/agent-onboarding/choices.md`).

**The manifest is the only list of code-owned agents.** Downstream callers
receive an already-scoped plan and never filter again; the gateway re-checks
containment but rejects the whole request rather than filtering it.

Scope is checked *after* `normalizeDrivePath`, and the ordering is load-bearing
even though that function **rejects** `.`/`..` segments rather than resolving
them: a raw prefix test would let `agents/alpha/../../escape.md` pass, because
it does start with `agents/alpha/`. Normalizing first means such a path is
refused before any root comparison happens.

Note that `scopeToManifest` itself does an un-normalized `startsWith`. It is
segment-safe (roots carry a trailing `/`) but not traversal-safe, and is only
sound because its input comes from a generator that walked a real directory
tree. **The traversal defense lives at the gateway, not in the seed package** —
do not reuse `scopeToManifest` on untrusted paths.

**The runtime never reads `content/` from disk.** `loadOfficialSeedFiles()`
decodes a generated module because serverless packaging prunes dot-directories
— a staging seed once shipped with no `.agents/**` at all.
`buildOfficialSyncPlan()` is synchronous, and that signature is the guard: a
disk walk is async and cannot appear without changing the call site.

**Servicing has one verdict owner.** `servicingStatusFor` answers "is this
workspace serviced?" for both reconciliation and workspace birth.
`desiredServicingStatus` stays user-only — it answers whether a *person* is
entitled, and teaching it about workspaces would give that question two owners.
A ban outranks an exemption.

## Pointers into the code

| Concern | Where |
|---|---|
| What the repo claims the hub holds | `buildOfficialSyncPlan`, `scopeToManifest` — `packages/official-agents-seed/src/index.ts` |
| Which agents are code-owned | `packages/official-agents-seed/manifest.ts` |
| Converging bytes, writing only diffs | `convergeDriveFile` — `packages/gateway/src/routes/files.ts`; route registered as `/converge-subtree` in `packages/gateway/src/routes/internalAdmin.ts`, mounted at `POST /v1/internal-admin/converge-subtree` (`packages/gateway/src/runtime/http.ts`) |
| Sync orchestration | `beginSync` / `completeSync` — `packages/backend/convex/domains/internalAdmin/officialHub.ts` |
| HTTP entry point | `POST /v1/internal-admin/official-hub/sync` — `apps/api/src/routes/internal-admin.ts` |
| Byte transport | `convergeOfficialHub` — `apps/api/src/gateway/client.ts` |
| Billing exemption | `servicingStatusFor`, `servicingExemptAt` — `packages/backend/convex/domains/credits/subscriptions.ts`, `domains/workspaces/birth.ts` |
| The button | `apps/web/spa/routes/internal-admin.tsx`, `apps/web/spa/api/client.ts` |
| Live proof | `packages/test-harness/src/staging-e2e-synthetic` (`marketplace:hub-sync`) |

Tests that pin the behavior: `packages/gateway/src/routes/internalAdmin.test.ts`
(no-op leaves mtime untouched, nothing deleted, traversal refused),
`packages/backend/src/official-hub-seed.test.ts` (repeat sync reconciles,
takedown survives, ports stay stable),
`packages/official-agents-seed/seed.test.ts` (scope filter, dot-directories),
`packages/backend/src/servicing-exemption.test.ts` (the verdict predicate).

## Where the build diverged from the plan

**The port-comparison "bug fix" was wrong and was reverted.** `MAP.md` landmine
⑩ and its slice both called for comparing `app.port` unconditionally, on the
theory that clearing a manifest port never propagated. Building it and testing
it proved the opposite: an absent manifest port means *"assign one"*, not
*"have none"*, and every seeded agent omits it — so comparing unconditionally
would report a difference forever and churn a running app's address on every
sync. The original guard in `appRegistrationDiffers` is correct and stands. A
test now pins port **stability** across a repeat sync. **Landmine ⑩'s port
claim is therefore wrong; the other two defects it names were real and are
fixed.**

**No whole-sync digest is computed.** The plan carried a `contentSha` and a
`syncedContentSha` column; both are gone, and with them a bug class the
drafting pass had ranked highly — a files-only digest would not have covered
`manifest.ts`, so editing an `installCommand` would have changed no file byte
and silently never reached subscribers. A **per-file** `sha256` does still
exist on `OfficialSyncPlan.files`; nothing gates on it, and its consumers are
`bun run inspect` and the drift test that pins the generated module to the
authored tree.

**Automation was deferred, not built.** The plan assumed a post-deploy hook
existed. It does not: `apps/api/vercel.json` defines a `buildCommand` that runs
*before* promotion, so a call from there would target the previous deployment,
and every PR preview shares the persistent staging Convex deployment. v1 is a
human pressing a button; `MAP.md` landmine ⑧ records what automation would need.

**One request replaced N.** The API previously awaited one `PUT` per file
inside a single serverless request, making the roster size a latent timeout.
Moving the comparison into the gateway required sending the tree in one
request, which retired that ceiling as a side effect.

**A latent e2e cleanup bug surfaced.** `retireUserIdentity` refuses while any
of a user's workspaces is live, and `login-as` with `create: true` always
provisions one — so the harness's operator-identity cleanup could never have
succeeded. It had simply never run, because the predecessor minted that
identity only on the install-failure diagnostic path. Cleanup now deletes the
identity's workspaces first, via `workspacesByOwnerForTest`.

## Dead ends — do not re-walk

- **A code-served `builtin` listing origin.** Fully designed, then rejected;
  see "Why this shape" and `MAP.md`.
- **Serving the hub's URL from code while keeping its Convex rows.** A URL
  naming a workspace, answered by code, backed by rows describing files that
  exist nowhere.
- **A whole-sync content hash gate.** Overturned: it made the button
  occasionally lie, and its digest could not see manifest-only changes.
- **`buildOfficialSeedBundle()` as the served archive.** It writes a ustar tar
  for the VM restore path; the marketplace puller parses zip with `fflate`.
  Different formats — do not wire them together.
- **Deleting files the repo dropped.** Would reach the VM's installed
  `node_modules` without an exclusion-aware mirror nobody wants to build.

## Visual provenance

There was no baseline, reference, or inspiration image for this feature. The
only visual surface is one button placed beside an existing sibling, and the
standard it was held to was that sibling's own treatment. The 36 internal-admin
regression baselines it moved live with their harness under
`apps/web/tests/visual/__screenshots__/{desktop,mobile}/playground.spec.ts/`.

An unprimed critique of the shipped shots is recorded in
[`choices.md`](choices.md): it found the navigating and mutating buttons
visually interchangeable — accepted without a fix, because a mis-click costs
nothing — plus seven pre-existing defects on that page which this feature
neither introduced nor fixed.

## Live evidence at close

`bun run e2e:staging -- --journey marketplace` passed on `934cb564`:
`firstSyncWrote: 0`, `secondSyncWrote: 0`, `hubEtagStable: true`, cleanup
`pass`, zero orphans. The stable ETag across two presses against real staging
is the byte-identical-rewrite invariant proved live.

## A trap in testing the exemption

Every live assertion about the exemption must be made at a clock **after the
owner's signup trial has lapsed** (`AFTER_TRIAL` in
`packages/backend/src/official-hub-seed.test.ts`). A magic-link account is
granted trial credits at birth, so at a small `now` the owner is genuinely
entitled and the hub reads `active` whether or not it is exempt — an assertion
made there passes no matter what the code does.

The first draft of these tests did exactly that. Two of the three were vacuous
and only the third failing revealed it. Falsifying the set — removing the
exemption line and confirming all three go red — is what proved they test
anything at all.

## Still owed

Nothing in this feature. Automation of the sync trigger is deliberately out of
scope (see the divergences above); it is a decision, not a debt.
