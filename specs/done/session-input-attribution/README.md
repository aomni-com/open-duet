# Session Input Attribution

Shipped 2026-08-05. Every durable session input — human, registered app,
sibling/parent session, or Duet itself — carries truthful authorship and one
durable clock; the model receives it as an escaped sender-specific envelope
with current identity; the web transcript names the actual author instead of
whoever is viewing it.

## What shipped

One identity-only union in `@repo/contract` (`SessionInputSenderSchema`:
`user`/`app`/`session`/`system`), required as `sender` on the three durable
input events `prompt_submitted`, `note_submitted`, `answer_submitted` (the
renamed `user_prompt`/`user_note`). The event row's `createdAt` is the only
input timestamp, and its `seq` doubles as the model-visible message identity —
the same value `history?cursor=<seq>` accepts, strictly-after. The old
session-message `origin` string, input `submittedAt`, and the plaintext
`<<<duet queued user notes>>>` composer are deleted with no aliases.

## Why this shape

- **Derived, never submitted.** Clients cannot claim authorship: the API maps
  the authenticated credential to the sender (`apps/api/src/session-sender.ts`)
  and the nested-create route authors as its parent from the path alone. The
  one caller-visible field, `sourceSessionId`, only names a session — and
  Convex proves it lives in the addressed workspace inside the same
  transaction that appends the event (`requireSenderSource`,
  `agentSessionsShared.ts`), so the API never holds a validation the database
  must re-prove (a pre-check would add a round trip and a TOCTOU window; this
  is why `resolveInputSender` is synchronous despite the plan sketching a
  Promise).
- **Identity-only storage, read-time names.** Events persist ids; names,
  emails, slugs, and titles are current lookups (backend delivery for model
  bytes, the browser's page-local directory for labels). A snapshot would be a
  second source of truth that lies after every rename.
- **`seq` over a synthetic message id.** The sequence already exists, is
  durable and ordered, and is a working history cursor — an id would add a
  second identity for the same row.
- **Human identity is name+email, never the internal user id.** Names and
  emails are useful to a model and to a person; the id is an internal handle
  (`runnerEnvelope.ts` cannot emit it; pinned by fixture and by the live
  journey).
- **A hard cutover.** No migrations, optional-sender phase, or dual readers:
  a transitional shape would have been the legacy architecture this feature
  exists to delete. Pre-cutover rows do not parse under the new union — see
  "Operational notes" below before promoting to an environment with old data.

## Invariants the code must keep honoring

- `sender` is required on durable input events only; neither the
  `agentSessionEvents` row nor non-input events gain an author, and
  `agentSessions.userId` / mutation `actorId` are never author fallbacks in
  product paths (the one deployed exception is the internal-key `*ForTest`
  seeding mutation in `convex/testing/agentSessions.ts`, which stamps its
  actor deliberately).
- Any `sessions`-scoped credential may assert `sourceSessionId`; introducing a
  key-kind-specific carve-out violates `SECURITY.md`'s one-trust-domain rule.
- Idempotent replays compare the author: same request id + different sender is
  a conflict, everywhere (`storedSenderMatches` in Convex; the early
  fingerprint-return branches included). The foreground-wait recovery lookup
  (`queries.ts` `waitInputIdentity`) is sender-safe indirectly — every API
  call site folds the sender into the request fingerprint — so keep the
  sender in those fingerprints. `isSameInputSender` in `@repo/contract` is
  the single equality owner (exhaustive switch — a fifth kind must fail
  compilation, not compare unequal to itself).
- Backend delivery owns the only model-envelope renderer
  (`packages/backend/convex/domains/agentSessions/runnerEnvelope.ts`); the
  gateway forwards its bytes untouched (`coordinator.envelope.test.ts` pins
  the exact forwarded bytes, which is what rules out reminder-wraps and
  answer prefixes). Attribute order is contract
  behavior: `seq`, `timestamp` (row clock, ISO UTC), `kind="answer"` when an
  answer, then identity. One single-pass escaper covers attributes and bodies.
- A human author whose user row is gone aborts the whole mutation — account
  retirement must preserve the user row. Deleted apps/sessions degrade to
  stable ids; a cross-workspace app id never borrows the foreign slug.
- Queued notes render inside `<queued_notes>` ahead of the primary input,
  each with its own sender/seq/timestamp; the wrapper precedes the primary
  even when a note's seq is higher.
- The web resolves authors through one seam
  (`apps/web/spa/sessions/session-authors.ts`: data-only directory +
  `resolveSessionAuthor`); message components never look identities up. No
  internal human id ever renders or announces — an unknown member is the amber
  invariant treatment, a loading roster is a placeholder bar. Optimistic rows
  are stamped with the viewer's sender and reconciliation compares sender as
  well as text. `data-message-attribution` carries the sender kind and is the
  harness's anchor.
- The input vocabulary stays neutral end to end: `appendSessionNote`,
  `ProjectedInputMessage` (`role: 'input'`), and — by Example User's follow-up call
  on 2026-08-05 — the public wire's delivery cursor `lastDeliveredInputSeq`
  (hard-renamed from `lastDeliveredUserSeq`, no alias; the databases were
  reset/edited rather than migrated).

## Pointers

Contract: `packages/contract/src/agent/index.ts` (union, events, requests,
`isSameInputSender`). API derivation: `apps/api/src/session-sender.ts` and its
test. Convex authority + idempotency: `agentSessionsShared.ts`
(`requireSenderSource`, `storedSenderMatches`), `delivery.ts`, `events.ts`;
arg validators in `agentSessions/model.ts` and `packages/backend/convex/validators.ts`. Renderer:
`runnerEnvelope.ts` + `runnerEnvelope.test.ts` (byte fixtures, adversarial
escaping). Web: `session-authors.ts`, `session-message.tsx`,
`projection/index.ts`, `session-data.ts`. Teaching:
`packages/skills-registry/skills/start-session/SKILL.md`, `build-apps`,
`packages/gateway/src/agents/parent-session-prompt.ts`,
`apps/docs/app/sessions/page.mdx`; roster guards in
`packages/skills-registry/src/roster.test.ts`. Live proof:
`packages/test-harness/src/staging-e2e-synthetic`
(stages `2b-durable-attribution`, `6-envelope-echo`,
`7-transcript-authors`). Decisions: [choices.md](./choices.md); planning
provenance: [MAP.md](./MAP.md) and the three biased drafts in
[assets/](./assets/).

## Live proof (run `staging-e2e-synthetic`)

The focused sessions-and-jobs journey, on deployed staging: a human input read
back `{kind:"user", userId:<actual>}` with only the row clock; a nested create
read back its parent-session author with `history?cursor=<seq>` strictly
after; a real runner turn echoed its envelope —
`{"seq":17,"timestamp":"2026-08-04T20:55:24.889Z","user_email":<current>}` —
with `seq` equal to the wait's `inputSeq`, the timestamp byte-equal to the
durable row, and the internal user id absent
([assets/live-proof/sessions-and-jobs-envelope-echo.json](./assets/live-proof/sessions-and-jobs-envelope-echo.json));
the deployed transcript named the actual member on the human row
([assets/live-proof/sessions-and-jobs-authors-default.png](./assets/live-proof/sessions-and-jobs-authors-default.png)).
The nested page was DOM-asserted to render a `session`-kind author row that
does not read as the viewer (the parent's name itself is not asserted); its
companion screenshot caught a post-assertion suspense skeleton (capture since
re-anchors on the asserted row). The journey's cleanup ledger reported every
resource deleted with zero orphans.

## Visual provenance

- [assets/visual-baseline/](./assets/visual-baseline/) — the pre-change
  desktop/mobile `session-authored-messages` playground baselines the work was
  measured against (copied from `apps/web/tests/visual/__screenshots__/`
  before any pixel moved).
- [assets/red-gate/](./assets/red-gate/) — the failing state that motivated
  slice 03: an app and a session wearing human initial portraits and
  id-derived labels under the old presentation.
- [assets/author-crops/](./assets/author-crops/) — before/after author-header
  crops used by the comparison verdict (desktop distance 0.049, mobile 0.078;
  change localized to relayed rows — human rows are content-identical, shifted
  a few pixels by the relayed rows' new chip height).
- [assets/live-proof/](./assets/live-proof/) — deployed-staging evidence, per
  above.

## Dead ends

- **A `system_vm`-only `sourceSessionId`** was drafted and rejected:
  SECURITY.md prohibits key-kind-specific request fields; within a workspace
  the field is provenance, not an isolation boundary.
- **Resolved author names on the history wire** (and any persisted display
  snapshot) — rejected; snapshots go stale and the browser already holds the
  identity data.
- **A required top-level user id on every event row** — rejected; only input
  events have authors.
- **Native structured runner answers** — deliberately not revived (the
  earlier native path was reverted upstream); the envelope only adds
  `kind="answer"` to the existing free-text transport.
- **Seven-slice ladders and a parallel staging journey** from the biased
  drafts — collapsed to four slices and an extension of the existing
  sessions-and-jobs journey, which already owned session fixtures and cleanup.
- **Per-app icons on transcript rows** — deferred: `AppIcon` resolves through
  a workspace file URL a transcript row should not fetch per author; the
  directory can carry an icon handle later.

## Operational notes

- Pre-cutover rows (old `user_prompt`/`user_note` events) do not parse under
  the new union. Resolved 2026-08-05 by Example User's full reset: staging Convex was
  wiped entirely, all exe VMs deleted (rebuilt image, pool-duet provisioning),
  and prod's only drifted rows were field-edited via the export→edit→import
  runbook (prod had no session data). No vestigial schema fields remain — the
  two wait-protocol leftovers briefly re-declared to unblock deploys were
  deleted once the data reset removed the rows that carried them.
