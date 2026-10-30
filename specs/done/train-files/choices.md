# Train-files — consolidated choices ledger

**Final ledger, consolidated 2026-07-23 against the shipped code** (duet
branch through `944c7a2d`, duet-agent v0.3.0). Every entry is a decision
made where the spec was silent, re-audited against the final tree; entries
superseded during the build were dropped. Grouped by verdict,
least-confident first — the top section is what deserves your eye.

## Needs your eye (least confident)

### Hand-edited memory files must be byte-canonical to parse

- **Where:** duet-agent `src/memory/store/file.ts` (kernel codec).
- **The choice:** The parser accepts only the canonical serialization:
  JSON-quoted strings, canonical key order, exact scalar grammar. A user
  who hand-edits a memory file and writes `headline: Foo` (bare YAML
  style) or reorders keys gets a warn-and-skip at session load — the file
  drops out of context until fixed — rather than a lenient parse.
- **Why it can be right:** one byte format, provable round-trips, no
  dialect drift between repos; failures are loud (stderr + Train UI),
  never silent rewrites that would churn sync.
- **Why you might overrule:** memories are user-editable content by
  design; the friendly alternative is order-insensitive, quote-optional
  reads with canonical writes. Changing later is cheap (parser-only).
- **Confidence:** Medium.

### The published pin stays exactly 0.3.0 while npm already has 0.3.1

- **Where:** `apps/api/src/config.ts` DEFAULT_AGENT_VERSION,
  `packages/contract/package.json`.
- **The choice:** The spec pinned 0.3.0 and the build shipped it. A
  concurrent session (connected-providers) released v0.3.1 from the same
  main minutes later; it contains all train-files work plus theirs. VMs
  reconcile to whichever pin staging's desired state carries — the two
  sessions' pin bumps will race benignly (0.3.1 is a superset).
- **Confidence:** Medium — resolved at close: the other session's 0.3.1
  bump merged in; the deployed pin is 0.3.1 and no action is needed.

### `--incognito` now also disables file-store memories

- **Where:** duet-agent `src/cli/run.ts` (slice 02 ride-along).
- **The choice:** incognito's contract is "no durable memory"; store
  files are durable memory, so incognito sets `memoryStores: false` too.
  An incognito session no longer sees trained knowledge at all.
- **Confidence:** Medium-high — consistent, but it changes what
  incognito users see.

### Auto-slug for store-backed notes

- **Where:** duet-agent `src/cli/memory-add.ts`.
- **The choice:** first five lowercase alphanumeric content words,
  hyphenated, capped at 48 chars, plus a random six-hex suffix; empty
  stems become `note`. Filenames like
  `use-explicit-evidence-grades-and-a1b2c3.md`.
- **Confidence:** Medium-high — cosmetic, but slugs are user-visible
  filenames in the drive.

### Intermediate hand-made stores inject at runtime but are not listed

- **Where:** `packages/gateway/src/train/agent-scope.ts` (whole-spec review
  fix).
- **The choice:** A `.agents/memories` folder created by hand in an
  intermediate, non-agent directory still reaches sessions (the CLI's
  upward walk is deliberately broader), but the Train UI's inherited list
  shows only ancestor agents' root stores plus the drive root. The
  alternative — listing intermediate stores — attributed their records to
  an owner whose Train page 404s on the detail (dead links).
- **Why you might overrule:** if you want every injected memory visible
  in the UI, the fix is a richer owner model (a "loose store" owner kind
  with its own read-only surface), not a revert.
- **Confidence:** Medium.

### Failed training jobs delete their corpus snapshot

- **Where:** `packages/gateway/src/train/job-ledger.ts` (whole-spec review
  fix).
- **The choice:** `fail()` now cleans the job directory exactly as
  `complete()` does. The previous "retain for retry" behavior kept
  snapshots no endpoint could ever reach — up to 1 GiB of unreachable
  disk per failed upload-backed job. A real retry feature would re-stage
  from the drive/uploads, not from the dead job dir.
- **Confidence:** High.

## Sound (verified against shipped code)


### a controlled child session separates inherited knowledge from child-owned knowledge

- **When:** Proving that a fresh child-agent session actually receives a root curated fact.
- **The choice:** The child is trained on a clearly unrelated “violet kestrel” operating marker,
  then a fresh session under that child's folder is asked the existing Northstar renewal question.
  A 20-percent answer can therefore come from the inherited root record, not from the child's own
  training document. The unbuilt alternative trained both scopes on overlapping business facts;
  that could produce the right reply while inheritance was broken.
- **The gap:** The slice required a context-level inheritance proof but delegated fixture content
  and did not prescribe how to rule out the child's own record as the answer source.
- **The reach:** Future staging changes must preserve one controlled source of the asserted fact;
  adding the root fact to the child fixture would make the live proof ambiguous.
- **Verdict:** Sound — the live-answer assertion tests the promised causal path, not merely a
  plausible final string.
- **Confidence:** Medium.

### new Train records are identified by before/after memory identity

- **When:** Selecting the records created by concurrent API jobs and the later browser-started job.
- **The choice:** The journey snapshots each scope's record list before starting work, then selects
  an owned record whose stable `memoryId` was absent from that baseline. It does not assume the new
  record is first or derive identity from a generated headline. The unbuilt alternative indexed
  the first row, which could silently validate an older staging record if ordering or seeded data
  changed.
- **The gap:** The slice required exact owned/inherited assertions but did not define how a live
  environment with pre-existing or seeded records identifies this run's output.
- **The reach:** Record ordering and headline generation may change without weakening acceptance;
  the wire-level memory identity remains the join used by both API and browser legs.
- **Verdict:** Sound — it controls staging residue without coupling the journey to presentation
  order.
- **Confidence:** Medium.

### staging agent creation has one fixture owner

- **When:** Adding a durable agent for scoped Train after the lifecycle journey's agent proved too
  short-lived to reuse.
- **The choice:** One fixture helper performs the public mkdir → `AGENTS.md` write → agent
  registration sequence and immediately records cleanup. Both lifecycle and Train acceptance call
  it. The unbuilt alternative copied that sequence into each journey, letting accepted cleanup
  statuses or registration order drift between two tests of the same public workflow.
- **The gap:** The slice said to follow existing provisioning conventions but did not assign a
  shared owner once a second journey needed the same fixture.
- **The reach:** Later staging legs that need a writable agent should reuse this public-API fixture
  rather than creating another registration protocol.
- **Verdict:** Sound — one helper preserves the actual manage-agents seam and cleanup discipline.
- **Confidence:** High.

### the Train acceptance leg owns its orchestration outside the root sequencer

- **When:** The scoped closeout added provisioning, two jobs, record inspection, and a child
  session to the already broad staging runner.
- **The choice:** `staging-e2e-synthetic` owns that complete feature leg and returns only the root job,
  root record, and agent evidence needed by the browser continuation. The top-level runner still
  owns ordering and pass/fail bookkeeping. The unbuilt alternative left hundreds of feature lines
  inline, making the global sequencer a second owner of Train behavior.
- **The gap:** The slice named `staging-e2e-synthetic` as the API-level journey but did not prescribe the
  module boundary inside the harness.
- **The reach:** Train assertions and their local oracle now evolve together, while the overall
  staging runner remains a composition surface like its other feature legs.
- **Verdict:** Sound — the boundary follows the harness's existing one-module-per-feature-leg
  architecture.
- **Confidence:** High.

### required scope follows each operation's existing inputs

- **When:** Adding the browser Train scope to the API-client method signatures.
- **The choice:** A caller first supplies the workspace and the operation's existing inputs, such
  as a record slug or update content, then supplies the required root-or-agent scope immediately
  before the optional cancellation signal. For example, a record fixture that already treats its
  second argument as the record slug keeps that meaning; the unbuilt alternative put scope second
  for every method, which shifted each later argument and forced unrelated playground fixtures to
  learn the new position even though their behavior did not change.
- **The gap:** The slice required every operation to accept scope but did not prescribe argument
  order.
- **The reach:** Slice 11 and later callers must still pass scope explicitly, while existing typed
  fixture functions keep the meaning of their resource and payload arguments.
- **Verdict:** Sound — the required boundary remains explicit without turning an internal API
  addition into unrelated fixture churn.
- **Confidence:** Medium.

### browser Train scope has one framework-free owner

- **When:** Sharing scope between browser transport, upload sessions, and query keys.
- **The choice:** The root-or-agent type, root constant, URL-family builder, and cache-scope
  serialization live in one small data-layer module with no React dependency. The API client
  re-exports the public type and root constant for its consumers. The unbuilt alternative defined
  scope inside the large API client, which would make upload and cache modules depend on that
  transport class just to identify the same target.
- **The gap:** The slice named every consumer but did not assign the shared scope contract to a
  module.
- **The reach:** Slice 11 can parameterize the existing Train UI from the same owner, and future
  path/key consumers cannot silently invent a second root-versus-agent representation.
- **Verdict:** Sound — one dependency-light owner keeps transport and cache identity aligned.
- **Confidence:** High.

### inherited owner attribution reuses the bounded agent projection

- **When:** Translating gateway owner anchors into public agent slugs.
- **The choice:** When an inherited record names a non-root owner anchor, the API loads the
  workspace's existing bounded agent list and builds an anchor-to-slug map for that response. It
  does not add a second backend query that resolves one anchor at a time. Responses with only own
  or root-owned records skip the lookup entirely.
- **The gap:** The slice assigned anchor-to-slug translation to the API but did not prescribe which
  existing agent-model read should supply the mapping.
- **The reach:** Agent Train list and detail share the same public agent projection as the rest of
  the API, while future work should add a dedicated bulk resolver only if the current bounded list
  becomes measurably expensive.
- **Verdict:** Sound — one bounded read avoids an N-query loop and does not create another identity
  lookup owner.
- **Confidence:** Medium.

### an unresolved inherited owner is a gateway failure

- **When:** Publishing inherited record ownership.
- **The choice:** If the gateway says an inherited record belongs to a non-root anchor but the API
  cannot find that anchor's agent slug, the API returns `gateway_failed` with HTTP 502. It does not
  leak the internal anchor id or silently omit the required public owner slug. Root-owned inherited
  records remain valid without an owner slug because the workspace root is not a named agent.
- **The gap:** The slice required complete owner-slug attribution and allowed existing 502
  semantics, but did not define the response to an inconsistent gateway/Convex projection.
- **The reach:** Web code in slices 10–11 can treat a successful inherited agent record as fully
  attributed instead of handling a third, ambiguous ownership state.
- **Verdict:** Sound — success preserves the public contract, while an internal projection mismatch
  fails closed without exposing internal identity.
- **Confidence:** High.

### replica upload sessions are mutations

- **When:** Applying the read-only policy to every agent Train route.
- **The choice:** A replica cannot mint an upload session, even though minting the short-lived token
  does not itself write a file. The token is the capability that authorizes a later direct browser
  upload to the replica's inbox, so allowing the session would create a write path that bypasses
  the API's replica guard.
- **The gap:** Decision 10 said every Train mutation must fail, while the slice's examples named
  upload put/delete but did not explicitly classify credential minting.
- **The reach:** Every route that can directly perform or authorize a replica Train write now
  refuses before contacting the gateway; later web upload code cannot accidentally acquire a
  usable replica credential.
- **Verdict:** Sound — guarding the capability mint is necessary for the promised read-only surface.
- **Confidence:** High.

### a job is either fully root-scoped or fully agent-scoped

- **When:** Extending the Convex train-job writer.
- **The choice:** `createJob` rejects calls that provide only one of the durable agent id and the
  public slug snapshot. Root jobs provide neither; agent jobs provide both. Without this check, a
  half-stamped row could be filtered as an agent job but generate a root email link, or carry an
  agent link while appearing in the root job list.
- **The gap:** The slice prescribed both stored fields and their consumers but did not explicitly
  state the relational validation rule at insertion.
- **The reach:** Job queries and completion emails may treat the two optional fields as one scope
  identity even though Convex's field validators cannot express that relationship themselves.
- **Verdict:** Sound — the write boundary enforces the only two states production can interpret.
- **Confidence:** High.

### the v2 ledger lives at `train/job-ledger.json`

- **When:** Concurrent job ledger replacement.
- **The choice:** The gateway writes the multi-job ledger to `train/job-ledger.json`. On a VM
  that still has the old singleton file, the gateway ignores that old file and starts from an
  empty v2 ledger; naming the new file after the durable concept keeps later versions inside the
  JSON version field instead of putting a version number in every future filename.
- **The gap:** Decision 9 required a new filename but did not prescribe its exact basename.
- **The reach:** Gateway boot and future Train work now treat this path as the sole persisted job
  state owner; the abandoned singleton file may remain beside it without affecting startup.
- **Verdict:** Sound — it is unambiguous, differs from the abandoned path, and avoids baking one
  schema revision into the filesystem name.
- **Confidence:** Medium.

### callers read jobs by id, and `start` returns the created snapshot

- **When:** Concurrent job ledger API design.
- **The choice:** Starting a job returns a copy of that job's new snapshot, and later reads use
  `snapshot(jobId)`. For example, two HTTP requests can each retain their own id and record slug;
  neither asks the ledger for a VM-wide "current" job, which would become ambiguous as soon as
  both are running. The unbuilt alternative was a separate lookup immediately after every start.
- **The gap:** The slice required every mutation to name a job id but did not prescribe the read
  method or `start` return value.
- **The reach:** Route failure handling, tests, and the later agent-scoped route slice all share
  the same per-job read seam and cannot accidentally reintroduce singleton ownership.
- **Verdict:** Sound — the seam makes job identity explicit and returns cloned snapshots so callers
  cannot mutate persisted state behind the ledger.
- **Confidence:** High.

### the upload-session mirror keeps workspace-member scope

- **When:** Slice 04 contract wiring.
- **The choice:** The root upload-session endpoint allows any authenticated workspace member to
  request a short-lived VM upload credential. Its new agent-scoped twin keeps that same
  `workspace_member` scope; the other Train endpoints continue to require the narrower workspace
  memory capability. Making every mirrored route use the memory capability instead would make the
  two upload-session contracts behave differently even though this slice requires exact parity.
- **The gap:** The slice overview says the agent family uses the memory scope, while the existing
  root upload-session endpoint uses workspace-member scope and the detailed task requires mirrored
  scopes to be identical.
- **The reach:** Agent upload-session authorization now follows the established root exception.
  Later route-mounting slices should preserve that exception unless the root contract changes too.
- **Verdict:** Sound — preserving the existing root scope is the only interpretation that keeps
  the required root/agent parity.
- **Confidence:** High.

### agent endpoint ids use one `train.agent.*` namespace

- **When:** Slice 04 contract wiring.
- **The choice:** Every agent-scoped Train endpoint adds `agent` immediately after the existing
  `train` id prefix, such as `train.records.list` becoming `train.agent.records.list`. The
  alternative was to invent per-resource forms such as `agent.train.records.list`, which would
  make pairing the two families harder for generators and tests.
- **The gap:** The task required distinct ids and provided one example, but did not prescribe the
  complete naming rule for all eleven mirrors.
- **The reach:** Generated docs and future endpoint-table consumers can pair root and agent Train
  entries by one mechanical prefix replacement.
- **Verdict:** Sound — it generalizes the supplied example and makes parity mechanically obvious.
- **Confidence:** High.

### archive presence requires a readable manifest object

- **When:** Root file-backed record projection.
- **The choice:** A record reports `hasArchive: true` only when its memory file names an
  `archiveId` and the corresponding private `manifest.json` exists, parses, and contains a JSON
  object. The memory file alone is not evidence that the private archive survived.
- **The gap:** The slice required the old archive-presence rule to stay honest, but did not define
  how corrupt or non-object manifest JSON should project onto the boolean wire field.
- **The reach:** List/detail degrade a missing or damaged private archive to `hasArchive: false`
  without making the otherwise valid curated memory unreadable.
- **Verdict:** Sound — the flag describes usable archive evidence, while record availability is
  owned by the shareable file.
- **Confidence:** High.

### equal creation times fall back to mtime, then slug

- **When:** File-backed record listing.
- **The choice:** Records sort by `createdAt` descending, then file mtime descending, then slug
  ascending when both timestamps tie.
- **The gap:** The slice prescribed the first two keys but left a possible exact tie unordered.
- **The reach:** List responses remain deterministic across filesystems and repeated tests even
  when records share both timestamps.
- **Verdict:** Sound — the final lexical tie-break does not alter the requested recency ordering.
- **Confidence:** High.

### gateway mutations emit semantic file events

- **When:** Finalize-install and train record update/delete.
- **The choice:** Emit `.agents/memories/<slug>.md` write/delete events through the existing
  file-event stream after successful gateway mutations. Event delivery is observational: a
  listener exception is swallowed rather than changing the already-committed filesystem result.
- **The gap:** The slice expected gateway-authored writes to appear in attribution, but the Linux
  fanotify helper deliberately excludes the gateway process's own PID.
- **The reach:** Activity attribution sees root Train mutations without changing fanotify or sync
  policy. Later agent-scoped Train routes should reuse this event seam.
- **Verdict:** Sound — it restores the intended observable behavior at the mutation owner and
  preserves the existing rule that telemetry cannot poison a successful write.
- **Confidence:** High.

### replacement cleans up only the superseded archive

- **When:** Installing synthesis output over an existing slug.
- **The choice:** Read the prior file before the atomic install and, after the new file lands,
  remove the prior private archive only when its `archiveId` differs from the new record's id.
- **The gap:** The slice explicitly defined delete cleanup and atomic replacement, but not the
  lifecycle of a private archive superseded by retraining the same slug.
- **The reach:** Retraining does not leak abandoned private corpus archives, and a failed install
  cannot erase the archive belonging to the still-current record.
- **Verdict:** Sound — cleanup happens only after commit and mirrors the old record rail's ownership
  of the archive lifecycle.
- **Confidence:** High.

### scope identity is tagged before it becomes a filesystem key

- **When:** Scoped upload leases and inboxes.
- **The choice:** Gateway code carries upload scope as either an explicit root value or an agent
  value containing a validated anchor id. Only the filesystem/token boundary turns that value into
  the required `root`-or-anchor directory key. The literal `root` is reserved and cannot also be an
  agent anchor: otherwise the root agent and an agent named `root` would point at the same inbox.
  A bare string everywhere would be shorter, but it would make that alias easy to construct by
  accident and would not show readers whether `root` means the root agent or an ordinary id.
- **The gap:** The slice fixed the on-disk keys and delegated the type name, but it did not decide
  how application code distinguishes the two kinds of scope or whether `root` is reserved.
- **The reach:** Upload authentication, token persistence, inbox caching, and later Train route
  mounts all inherit one unambiguous scope identity. Any future producer must construct the tagged
  value before it can reach a scoped path.
- **Verdict:** Sound — the representation makes the security boundary explicit and prevents the
  only namespace collision in the specified directory layout.
- **Confidence:** High.

### the request path, not token text, selects the scope to verify

- **When:** Scoped upload authentication.
- **The choice:** Upload tokens remain opaque random strings. For a request to agent A's upload
  URL, the gateway first parses and validates A from the URL, then verifies the token only against
  A's persisted record; that record also names A and stores only the token hash. A token could have
  carried a readable scope prefix instead, but then authentication would still need to compare that
  caller-presented claim with the URL and would expose internal anchor ids without removing any
  persisted state.
- **The gap:** The slice required tokens to carry and verify scope, but did not specify whether the
  raw credential should encode it or whether the trusted persisted record should bind it.
- **The reach:** A credential copied from one inbox always receives 401 at another inbox, while
  browser-visible credentials remain opaque and the URL stays the sole requested-resource owner.
- **Verdict:** Sound — scope comes from the resource being accessed and is checked again in the
  persisted credential, rather than trusted from bearer-controlled text.
- **Confidence:** High.

### snapshots may move only into the Train jobs tree

- **When:** Per-scope inbox snapshot handoff.
- **The choice:** A scoped inbox can be atomically renamed only to a destination beneath
  `state/train/jobs/`. The previous single-inbox store allowed any destination beneath
  `state/train/`; retaining that rule would let a mistaken caller target another scope's upload or
  temp directory. The jobs tree is the one durable handoff owner used by the training pipeline.
- **The gap:** The slice required per-scope atomic snapshot moves, but did not restate how narrowly
  the destination should be bounded after inboxes gained sibling scope directories.
- **The reach:** Slice 08 can add agent job directories beneath the same jobs root without gaining
  a primitive capable of replacing or consuming another live inbox.
- **Verdict:** Sound — the narrower boundary expresses the actual handoff contract and removes a
  cross-scope misuse path.
- **Confidence:** High.

### inherited gateway records carry an internal owner scope

- **When:** Agent-scoped inherited record projection.
- **The choice:** Inherited list and detail entries include `ownerScope` containing the owning
  anchor id or `root`, alongside `inherited: true`. The gateway deliberately leaves
  `ownerAgentSlug` unset; slice 09 can translate this internal identity at the public API boundary.
- **The gap:** The slice assigned slug attribution to the API and required mutation conflicts to
  name an owner, but it did not prescribe how the gateway would carry that owner through read
  responses for the API to translate.
- **The reach:** The agent API can attribute every inherited record without reimplementing the
  gateway's nearest-wins store walk or guessing ownership from a record slug.
- **Verdict:** Sound — ownership travels with the record at the component that resolved it, while
  the gateway still does not learn or expose user-facing agent slugs.
- **Confidence:** High.


### the record path is the selection owner

- **When:** Sharing record-detail navigation between root Train, agent Train, and inherited-owner
  links.
- **The choice:** Every trained memory has a dedicated nested path:
  `computer/train/:memorySlug` for root memories and
  `computer/train/agents/:agentSlug/:memorySlug` for agent memories. Following an inherited row
  uses the owning scope's path. The route parameter owns selection; the library keeps no parallel
  selected record state. Earlier `?record=:memorySlug` bookmarks and agent-detail Train URLs
  replace-redirect to that canonical path so moving selection out of the library does not strand
  existing links.
- **The gap:** The slice required both wrappers to parse deep links but did not say whether the URL
  or local React state owned selection after the first render, nor whether the detail should remain
  embedded in the training controls.
- **The reach:** Root, agent, and owner-navigation flows now have one bookmarkable selection
  contract. Future record navigation should use the nested path rather than create a second state
  owner or inline detail state.
- **Verdict:** Sound — one URL owner makes deep links, Back, and in-page selection converge on the
  same state while giving reading and editing their own layout.
- **Confidence:** High.

### replica copy names the owner without inventing an origin route

- **When:** Explaining why a shared-in agent has no Train mutation controls.
- **The choice:** Replica surfaces say that only the owner can change training, but do not offer a
  "View origin" link. A shared agent can originate outside the current drive, and the roster data
  available here identifies the share but does not provide a routable origin destination. The
  unbuilt alternative presented an action that would either guess a local route or imply that
  "origin" was always reachable.
- **The gap:** Decision 10 fixed replica mutability but did not define an origin-navigation
  contract or the explanatory copy.
- **The reach:** Later work may add an origin action only when the public agent/share contract
  supplies an authorized destination; until then the read-only UI stays truthful.
- **Verdict:** Sound — the surface explains authority without manufacturing a navigation contract
  the data layer does not own.
- **Confidence:** Medium.

### agent memory counts cross the VM boundary once

- **When:** Adding the agent directory to the root Train memory library.
- **The choice:** `GET /train/agent-memory-counts` returns owned-memory totals for every projected agent
  in one compact response. It stays outside `/records/:slug`, preserving `counts` as a valid memory
  slug in every scope. The gateway keys its internal response by anchor id; the API translates those
  keys to public agent slugs before the browser sees them. The public endpoint requires both memory
  and agent-list capabilities, and isolates a broken agent store as a null unavailable count instead
  of failing the directory. A Train completion invalidates this shared count query regardless of
  which scope completed.
- **The gap:** The first UI pass reused each agent's full record-list endpoint. That preserved the
  requested totals but turned the root page into one HTTP request and full summary download per
  agent.
- **The reach:** Directory consumers use the batch endpoint rather than fan out record queries.
  Counts describe memories owned by the agent; inherited memories remain a separate section on the
  selected agent route.
- **Verdict:** Sound — one small response keeps the directory useful as workspaces grow and
  preserves the public slug/internal anchor boundary.
- **Confidence:** High.

### Scope-aware isRunning at the 06/07 integration seam

- **Where:** `packages/gateway/src/routes/train-uploads.ts`,
  `runtime/http.ts` (orchestrator integration commit).
- **The choice:** The upload routes' `isRunning` became context-taking —
  mirroring `resolveStore` — so each mount reports "a job is running for
  THIS scope" instead of a VM-wide boolean or a hardcoded root scope. The
  auto-merge of the two parallel slices had silently produced a throwing
  call and a wrong-scope call; this is the semantic union of both slices'
  contracts, added with a route-level regression test.
- **Confidence:** High.

### Exactly-one-write-target errors, never first-flag-wins

- **Where:** duet-agent `src/memory/store/sources.ts`, CLI commands.
- **The choice:** `duet train --store A --store B` (or any two write
  targets) is a usage error naming the rule, rather than silently writing
  to the first. Reads still union everything. The error text:
  "Memory writes require exactly one --store <folder> or --db <file>;
  pass only one write target."
- **Confidence:** High — spec decision 4 said error; the message wording
  and the reads-still-union behavior were the silent parts.

### Unknown frontmatter keys survive round-trips under `extra`

- **Where:** duet-agent `src/memory/store/file.ts`.
- **The choice:** Unknown scalar keys parse into an `extra` map and
  re-serialize after the known keys, byte-stably — so an older
  content-only editor cannot silently delete metadata a newer writer
  added. Rejected alternative: reject unknown keys (would make future
  format additions a breaking change for older VMs).
- **Confidence:** High.
