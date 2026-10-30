# Schema cleanup — implementer choices

The original plan and the user's explicit reset decisions are givens, not
implementer choices. This ledger records the additional decisions embedded in
the shipped architecture. No unsound or user-only choices remain.

## Sound choices

Entries are ordered from least to most confidence that the user would have
made the same call.

### Isolate the deployed percent-path seam without replaying model generation

- **When:** final staging closeout.
- **The choice:** The focused `drive-percent-identities` journey creates two
  known files, then reads and reloads them through the browser's same-origin
  Duet proxy. It does not ask a live model to emit a link and does not require
  the product page's separate Convex-auth session. The full Drive journey still
  covers model-emitted links and the Files UI.
- **The gap:** The full suite found a proxy 404, but its model-generated link
  prerequisite is stochastic. The plan did not say how to rerun only the
  deterministic failing transport.
- **The reach:** Future proxy regressions can be proved or cleared quickly
  without consuming a complete agent journey. It is a narrow staging oracle,
  not a substitute for the full Drive journey.
- **Verdict:** sound — it tests the exact deployed component chain that failed
  while preserving broader coverage elsewhere.
- **Confidence:** medium.

### Keep caller-specific credit audit data under one context bag

- **When:** credit metadata unification.
- **The choice:** Fields owned by the reservation lifecycle remain typed at the
  top level. Provider, top-up, generation, or operator details supplied by a
  caller live under `metadata.context`; a primitive legacy value becomes
  `context.value` rather than disappearing.
- **The gap:** Existing callers could pass arbitrary metadata, while the final
  ledger needed a closed schema. The plan did not choose how to retain useful
  old audit payloads without reopening the whole object.
- **The reach:** A new caller can add audit context without accidentally
  defining a new ledger state field. Readers must look under `context` for
  caller-owned details.
- **Verdict:** sound — the boundary distinguishes accounting state from opaque
  provenance and preserves historical information.
- **Confidence:** medium.

### Keep portrait policy above file transport

- **When:** agent portrait completion.
- **The choice:** `DriveFileIcon` owns versioned Drive loading and failure
  detection. `AgentAvatar` owns the product identity policy above it: authored
  Duet art, uploaded portraits when present, and deterministic local art keyed
  to the package name or installed-agent slug otherwise.
- **The gap:** File-backed icon transport could not decide what identity should
  appear when no file exists, nor keep that identity coherent across product
  surfaces and editable display names.
- **The reach:** Every agent-facing surface consumes one portrait contract
  without moving product identity into the shared UI package or persisting
  generated art into Drive.
- **Verdict:** sound — transport and identity each have one owner, and display
  copy can change without changing the portrait.
- **Confidence:** high.

### Resolve file users at read time and tolerate deleted identities

- **When:** file-activity identity cleanup.
- **The choice:** Stored events keep the authenticated `actorContext`. Queries
  resolve that actor to a current user when possible; if the referenced
  session, API key, or user has since disappeared, the event remains readable
  without a `userId`.
- **The gap:** The plan chose read-time identity resolution but did not specify
  what historical reads should do after identity cleanup.
- **The reach:** File history, latest-writer views, workspace feeds, and SSE all
  report attribution consistently and cannot be broken by deleting an
  authentication record.
- **Verdict:** sound — enrichment is optional history context, not the event's
  existence condition.
- **Confidence:** high.

### Do not let malformed optional token analytics block billing

- **When:** model token attribution.
- **The choice:** If an upstream response contains unusable optional token
  fields, Duet omits those analytics but still settles a valid priced
  generation. Aggregate token fields are preferred; native fields are the
  fallback.
- **The gap:** The plan required token counts to reach rollups but did not
  define failure semantics for malformed optional metadata.
- **The reach:** Usage reports may lack token detail for a malformed response,
  but money settlement does not retry or fail because of nonessential
  analytics.
- **Verdict:** sound — reporting degradation must not create a billing
  correctness failure.
- **Confidence:** high.

### Move producer and consumer deployments together after a reset

- **When:** production reset recovery.
- **The choice:** When the final backend rejected messages from the old API and
  gateway, the stricter contract remained in place and the matching
  application producers were deployed. The alternative—making new fields
  optional again or patching database rows directly—was rejected.
- **The gap:** The reset plan described database order but not recovery from a
  still-deployed producer using the previous message shape.
- **The reach:** A green schema deployment is not treated as proof that an
  environment works. Any future strict contract cutover must include every
  deployed producer.
- **Verdict:** sound — it preserves the intended contract instead of encoding
  stale deployment compatibility into the final schema.
- **Confidence:** high.

### Restore the official hub only on current VM producers

- **When:** production bootstrap.
- **The choice:** Official workspaces were first created without the starter
  bundle, moved to the promoted VM image, and then seeded through the supported
  idempotent operator flow. The starter bundle was published only after hub
  verification.
- **The gap:** A fresh workspace normally receives starter content
  immediately, but the old image-baked gateway reported the obsolete
  reconciliation shape before it could be upgraded.
- **The reach:** This ordering is specific to full-environment recovery.
  Ordinary new workspaces still receive the normal starter bundle at birth,
  and official-hub rows remain owned by the operator flow.
- **Verdict:** sound — it avoids a bootstrap deadlock without creating a
  compatibility path or bypassing the hub lifecycle.
- **Confidence:** high.

### Treat the VM-update singleton as an explicit brake

- **When:** reset recovery and VM convergence fix.
- **The choice:** A missing `vmUpdateControl` row means updates flow.
  `paused: true` is the only brake. Both reset environments also received an
  explicit enabled row so operator intent remains visible.
- **The gap:** Resetting the database removed the singleton, and the old
  missing-row default silently stopped all VM convergence.
- **The reach:** Correctness no longer depends on hidden seed data. Operators
  can still pause globally with one visible record.
- **Verdict:** sound — absence is safe and the row expresses an exception
  rather than a prerequisite.
- **Confidence:** high.

### Let the live API own VM component release pins

- **When:** staging VM-version closeout.
- **The choice:** The authenticated VM release manifest announces desired
  agent and duetfs versions. The staging harness compares a fresh VM's gateway
  and agent versions to live API values; it does not copy those release
  constants. Duetfs is announced but is not currently part of this convergence
  assertion.
- **The gap:** A version bump made the full journey fail because the API and
  test each carried a different hard-coded pin.
- **The reach:** Future release bumps change the deployed owner once. Existing
  gateway clients tolerate the additive manifest fields.
- **Verdict:** sound — the deployment being judged is also the authority for
  what it intends to run.
- **Confidence:** high.

### Judge reboot recovery by safety and durable state

- **When:** active-turn staging closeout.
- **The choice:** After a proven VM and gateway restart, the old turn may end
  as `interrupted` or `complete`. An unfinished durable state machine keeps the
  item in active Jobs; a terminal one moves to history. A fresh prompt must
  still be accepted and complete.
- **The gap:** The original check assumed every safe restart must emit
  `interrupted`, but the runner can resume persisted work and complete it
  correctly.
- **The reach:** The test guards the actual product promises—no stuck turn
  lock, no lost durable task, and continued usability—without rejecting a
  valid resumed completion.
- **Verdict:** sound — the state machine, not one event label, owns job
  liveness.
- **Confidence:** high.

### Decode the raw browser proxy path exactly once

- **When:** final Drive deep-link fix.
- **The choice:** The web proxy derives segments from the raw `Request.url`,
  decodes each segment once, then re-encodes it for the API. It does not trust
  Next.js catch-all parameters, which have already passed through framework
  routing.
- **The gap:** Local tests supplied decoded route parameters directly, while
  the deployed router transformed an encoded-looking literal filename a
  second time and produced a 404.
- **The reach:** Literal `%`, literal `%2F`, encoded leading slashes, and normal
  separators retain distinct identities across browser, web, API, and VM
  boundaries. Synthetic server callers may still pass explicit segments.
- **Verdict:** sound — it establishes one decoding owner for the general path
  contract rather than special-casing the failed filename.
- **Confidence:** high.

## Compressed low-impact discretion

Eight implementation details did not create durable architecture: preserving
exact-name matching in a staging cleanup scan, bounding an unindexed feedback
fixture, retaining mechanically generated bindings, deleting an orphaned seed
constant with its field, reusing the actor resolver across all read surfaces,
keeping wallet allocation as one nested value, removing the unused
visitor-attribution helper that guessed the app owner, and sharing the
hashed-token trio helper. Each follows an existing contract and has no
user-facing alternative to decide.
