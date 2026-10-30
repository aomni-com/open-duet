# Session Input Attribution — Choices

The decisions behind the shipped feature, re-audited against the final code
(2026-08-05). Grouped by how much they deserve your attention, least-confident
first. Everything here is a choice someone made on your behalf; per-slice test
evidence and gate results live in the git history of the build-time slice
files (deleted at closeout), and the live proof in the README.

## Needs your eyes

- **The scripted onboarding kickoff is authored by Duet, not the person.**
  Opening an agent's onboarding session shows the kickoff prompt labeled
  "Duet" (`{kind:"system"}`), because the product wrote that prompt, not the
  user who clicked the button. Truthful, but it changes what new users see
  first. Flip the sender in `openOnboardingSession` if you want onboarding to
  read as the person's own ask.
- **System rows shipped with the constant `Duet`, never a workspace's renamed
  `duetName`.** *Decided by Example User 2026-08-05: use `duetName`.* A system row now
  reads whatever this workspace calls its assistant, falling back to "Duet"
  when it has no name of its own; the name rides the author directory as
  workspace identity (not locale copy), so `resolveSessionAuthor` is still the
  only owner of the label, and the mascot portrait is unchanged.
- **App and session rows wear a category chip ("App", "Session") and the
  "From {source}" prefix is gone** — `fromSource` was deleted from both
  message catalogues. The prefix said a row was relayed but never what the
  source *was*, which is the distinction this feature exists to make. Humans
  and Duet carry no chip; their portrait answers the question.
- **Every registered app shipped with the generic app mark, not its own icon.**
  *Decided by Example User 2026-08-05: show the real icons.* The directory now answers
  `appIconUrl(appId)` from the apps query the page already makes, so an app is
  recognized by its own icon — one browser-cached `<img>` per unique app, no
  per-row request — while an app with no icon, a deleted app, an icon that
  fails to load, and any surface that cannot serve workspace files (the
  hermetic fixture, tests) all keep the generic mark in the same footprint.
- **`lastDeliveredUserSeq` kept the old "user" word on the public wire.**
  *Decided by Example User 2026-08-05: rename it.* Now `lastDeliveredInputSeq`
  end-to-end — Convex column, closed mutation return validators, and the
  third-party-visible session snapshot/create wire — with no alias or
  migration (staging wiped; prod had zero session rows).

## Where the shipped code deviates from the spec's own sketch

Each of these follows the spec's invariants over its illustrative signatures.

- **`resolveInputSender` is synchronous and takes no `workspaceId`** (the
  slice sketched a Promise with one). Derivation needs no I/O: Convex
  validates the source session inside the same transaction that appends the
  event, so an API-side pre-check would only add a round trip and a TOCTOU
  window.
- **`AttributedInputRow` carries a resolved sender beside the durable row**
  (the sketch had only `{seq, createdAt, event}`) — a pure renderer cannot
  look identity up, so delivery resolves it and the renderer stays pure.
- **`resolveSessionAuthor` takes a third `copy` argument and the directory is
  data-only** (`rosterLoaded`, `duetName`, `memberName`, `appName`,
  `appIconUrl`, `sessionTitle`; the sketched `authorOf` is gone). Three of the
  resolver's outputs are locale copy, and the directory is built outside locale
  context; splitting labeling across a directory *and* a resolver would have
  given a row's words two owners.

## Sender derivation and validation

- **Authorship is derived, never submitted.** The API (`session-sender.ts`)
  maps credential → sender: person-like credentials to `{kind:"user"}`, an app
  key to its app, the workspace VM key to `{kind:"system"}`; the nested create
  route authors as its parent session from the path alone, whatever credential
  carried it. The one caller-visible field is `sourceSessionId`, accepted from
  ANY `sessions`-scoped credential (a system-VM-only carve-out would violate
  SECURITY.md's ban on key-kind-specific request fields).
- **Convex is the authority on a session sender.** `requireSenderSource` runs
  inside the appending transaction, before side effects; missing, malformed,
  deleting, and other-workspace sources all answer the same non-disclosing
  404 family on every input route. The validator takes `v.string()` rather
  than `v.id(...)` so a malformed id reaches that path instead of leaking a
  Convex argument-validation error.
- **`SenderDerivationError` → 403.** Its triggers (`sync_device`, an app
  credential missing its app payload, a person-like credential missing its
  user id, an unknown credential kind) are unreachable past the capability
  gate and auth parsing; the failure stays closed without a new error code.
- **Deleted wire fields are stripped, not hard-rejected.** Schemas stay
  tolerant (repo policy: `.strict()` is an anti-pattern), so an old `origin`
  or `submittedAt` key is dropped; the old `user_prompt`/`user_note`
  discriminants fail parsing outright, and a stripped field can never reach
  durable history. Already-strict `*.wait` variants still reject unknown keys.
- **Idempotency includes the author.** Sender rides in every input
  fingerprint and is compared on every replay path (including the early
  fingerprint-match returns): same request id + same sender deduplicates,
  same id + different sender conflicts. `isSameInputSender` in
  `@repo/contract` is the one equality owner, delegated to by Convex and the
  browser, and written as an exhaustive switch so a fifth kind fails to
  compile instead of quietly conflicting with itself.
- **`agentSessions.userId` and `actorId` never author anything.** They keep
  their creator/ownership/authorization roles; analytics still keys on the
  session creator (explicitly out of scope to redesign).

## Time, envelope, and delivery

- **One input clock.** The event row's `createdAt` is the only durable input
  time, serialized as ISO UTC in the envelope; `submittedAt` is gone.
- **The model sees current identity, never the user id.** The envelope
  carries current full name (when a trimmed non-empty name exists) and email
  for humans; durable `app_id` plus current `app_slug` for apps (a deleted or
  other-workspace app degrades to id-only — borrowing a foreign row's slug
  would leak it); durable `session_id` for sessions; nothing for system.
- **A missing human author aborts the whole mutation** — stronger than the
  spec's "fail delivery": the just-appended row rolls back too, so no
  undeliverable input is left behind and no id-shaped substitute ever renders.
- **One renderer, one escaper.** `runnerEnvelope.ts` in backend delivery is
  the only place durable input becomes model bytes; the gateway forwards them
  untouched (pinned by test). A single-pass escaper covers all five XML
  characters in both attribute and body context, which is what makes forged
  envelopes and `<system-reminder>` text inert without double-escaping.
- **Notes group ahead of the primary input, sorted by their own seq**, each
  keeping its own author and clock; children indent two spaces and multi-line
  bodies are never re-indented (that would alter user text). Answers reuse
  their sender's message element with `kind="answer"` after `timestamp`.
- **Identity lookups dedupe per composition**, so a long single-author note
  drain costs one read.

## Web presentation

- **The transcript names the actual author.** One page-local directory (one
  roster query; an apps query only when an app sender appears; session titles
  from already-cached summaries) feeds one resolver; `session-message.tsx`
  renders the result and looks nothing up. Optimistic rows are stamped
  `{kind:"user", userId: viewer.id}` at creation and reconciliation compares
  sender as well as text, so someone else's identical words can never retire
  the viewer's pending row.
- **A human is named or declared broken — never shown as an id.** Roster
  loaded but member missing renders the amber "Unknown member" invariant
  treatment; roster still loading renders a placeholder bar (an ellipsis read
  as a failed name). Internal user ids appear in no visible or accessible
  copy on any human row. Apps and sessions degrade to the shared 12-char
  `shortIdLabel` — for them the id is a real handle.
- **"How a session names itself" has one owner** (`sessionDisplayLabel`):
  the lineage chip and the transcript author label cannot drift.
- **Portraits are typed with the label** (`person | person-unknown |
  person-pending | app | session | duet`), so a mark can never disagree with
  the name beside it; only system rows borrow the Duet mascot.
- **The note badge trails the timestamp as a plain label** — beside the
  category chip in pill grammar it read as a second claim about the author.
  The author name is `font-semibold` so it wins its row.
- **Message stacking groups by sender identity**, so consecutive rows from
  two different members no longer merge into one stack (the old origin-string
  comparison lied about that).
- **The input vocabulary is gone everywhere, not just the wire**:
  `appendSessionNote` (Convex), `ProjectedInputMessage` with `role:"input"`
  (web) — an app- or system-authored row never wears a "user" name or role.

## Teaching and proof

- **Stale-claim guards live in the skills roster tests, not the docs.**
  Roster tests pin that start-session teaches `sourceSessionId` and that
  build-apps no longer claims the VM key cannot start sessions ("origin"
  appears legitimately all over the docs, so a prose grep there would
  false-positive; the docs' schema-validated examples carry that surface).
- **The VM-key correction is code-verified**: `vmModelScopes` grants
  `sessions`; input sent with that key authors as Duet. The archived
  app-api-keys rationale was corrected in the same pass.
- **The live journey asserts contracts it can hold deterministically**: it
  creates its own nested child for the parent-session sender and
  strictly-after cursor proof (rather than trusting how the delegated agent
  chose to create its child), ties the model's envelope echo byte-for-byte to
  the durable row clock and the wait's `inputSeq`, and asserts the deployed
  transcript by `data-message-attribution` plus the member label — adversarial
  escaping and credential permutations stay deterministic local tests, per
  the spec's prohibition on forging provenance with a user token.

## Discovery-phase decisions (unchanged, verified against shipped code)

- **One truthful four-kind union** (user, app, session, system); `origin`
  deleted; neutral event names (`prompt_submitted`, `note_submitted`,
  `answer_submitted`); `sender` required only on durable input events — no
  top-level row user id.
- **Sequence replaces message id.** The envelope's `seq` is the same durable
  `events[].seq` that `history?cursor=<seq>` accepts, strictly-after; no
  synthetic id, no before-cursor endpoint.
- **History stays identity-only** — no display-name snapshots on the wire;
  model identity is resolved by backend delivery, UI labels by the browser.
- **Missing-user behavior is strict** (account retirement must preserve the
  user row); deleted apps/sessions use stable-id fallbacks.
- **Email may stay visually secondary** on the web when a real name exists;
  it is always model-visible.
- **Keep free-text answer transport** — `kind="answer"` on the envelope, no
  native structured-answer revival (the earlier native path was deliberately
  reverted upstream).
- **Hard cutover, no legacy** — no migrations, aliases, dual schemas, or
  deploy choreography; the database may be wiped. Note for prod promotion:
  pre-cutover event rows do not parse under the new union, so old sessions'
  transcripts fail to load until those rows are stripped (staging retains
  them; the journey uses fresh sessions).
- **Extend the existing sessions-and-jobs journey** rather than adding a
  parallel fixture owner; **preserve unrelated namesakes** (task origins,
  analytics origins, marketplace origins, HTTP origins, `wakeAt`).
