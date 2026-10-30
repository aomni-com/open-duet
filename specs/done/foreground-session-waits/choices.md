# Foreground session waits — final choices ledger

This is the consolidated record of implementation decisions made while resolving
details beyond the public contract. It is ordered by verdict and then by
confidence, with the choices most worth revisiting first. The final shipped code
contains no unsound or needs-user choice.

## Sound

### Boundary-less relay retries keep their deployed fingerprint

- **When:** Whole-feature review.
- **The choice:** An old relay message with no `acceptedThroughSeq` is hashed
  exactly as it was before this feature. New coverage-bearing messages hash the
  event together with that boundary. Consider a backend that committed an old
  relay but lost the response during deploy: the gateway retries the same relay
  ID. Wrapping that old event in a new object would make a legitimate retry look
  like conflicting data.
- **The constraint:** The new causal field changed relay identity while
  already-persisted outboxes could cross the deploy boundary.
- **The reach:** Additive relay identity fields must preserve the fingerprint of
  messages that genuinely predate those fields.
- **Verdict:** Sound — old outboxes keep draining, while changing the accepted
  boundary on a new relay is still detected as a conflict.
- **Confidence:** High.

### A default alias is part of idempotency identity

- **When:** Whole-feature review.
- **The choice:** Root-default and each agent-default route include their logical
  owner in the wait fingerprint before resolving the current canonical session.
  If a caller accidentally reuses one UUID for identical text sent to root and to
  agent `researcher`, those are two submissions, not one. Using only workspace,
  UUID, and text would silently collapse them.
- **The constraint:** Ordinary message request IDs are session-scoped, while
  recovery for a mutable default alias must work even after that alias points
  elsewhere.
- **The reach:** Recovery remains independent of alias rebinding without allowing
  two distinct logical aliases to deduplicate onto one another.
- **Verdict:** Sound — the stable route owner disambiguates requests without
  coupling retry identity to a mutable alias target.
- **Confidence:** High.

### Idempotent recovery runs before mutable routing checks

- **When:** Whole-feature review.
- **The choice:** An initial wait retry first searches read-only for its committed
  input using the authenticated actor, UUID, fingerprint, and durable wait marker.
  Only a genuinely new request resolves current capability, parent, default alias,
  spend, and image state. For example, if an input committed and the response was
  lost just before its parent was deleted, retry still observes that exact input
  instead of returning 404 or creating work elsewhere.
- **The constraint:** Capability readiness, parents, and aliases can change
  between a committed input and an ambiguous client disconnect.
- **The reach:** Create retries use the per-actor creation claim; canonical
  session retries use the session event index; alias retries use a bounded
  workspace index and fail closed when UUID reuse is ambiguous.
- **Verdict:** Sound — recovery never stores images or appends input, while new
  requests still fail current preflight before mutation.
- **Confidence:** High.

### Parent-session teaching includes one complete executable path

- **When:** Agent teaching.
- **The choice:** The injected parent context includes the `/messages/wait`
  request, same-request retry, and contextual history lookup. The full
  operation matrix and foreground/background distinction stay in the authored
  `start-session` skill and public docs. Merely saying “read the skill” was too
  easy for a live child to skip; copying the whole skill into every launch would
  inflate each prompt.
- **The constraint:** Launch context had to stay compact while parent
  communication remained self-sufficient and reliable.
- **The reach:** Relationship-specific launch layers carry one usable action;
  general API instruction remains in the skill registry.
- **Verdict:** Sound — a child can contact its parent without discovery or polling
  ceremony, while generated context does not duplicate all six routes.
- **Confidence:** High.

### One structured submission kernel serves async and wait adapters

- **When:** Shared submission and public routes.
- **The choice:** `submitSessionInput` owns image lifecycle, durable preparation,
  integration synchronization, dispatch, and delivery normalization. Route
  adapters retain only operation-specific fingerprints, preparation fields, and
  their existing response shapes. Forcing create, message, answer, and defaults
  into one giant operation union would move route knowledge rather than remove it;
  copying the side-effect sequence would create competing owners.
- **The constraint:** One persistence path had to serve intentionally different
  public operations without erasing their local response ownership.
- **The reach:** A future submission mode extends the kernel's structured outcome
  instead of cloning storage and dispatch logic.
- **Verdict:** Sound — side-effect ordering has one owner while legacy async
  serializers remain visibly local and unchanged.
- **Confidence:** High.

### Live events own normal wakeups

- **When:** API observer and cursor.
- **The choice:** After the initial durable query, a healthy gateway stream waits
  without periodic rechecks. Activity triggers an immediate durable query. Only
  stream closure or connection failure enters bounded reconnect backoff; the
  request deadline remains the sole timer on a healthy connection.
- **The constraint:** Stream reconnects can replay activity, and VM or gateway
  restarts can temporarily make the stream unavailable.
- **The reach:** SSE owns latency while the durable query owns correctness.
- **Verdict:** Sound — the normal path is event-driven without allowing failed
  reconnects to spin.
- **Confidence:** High.

### Covering-terminal lookup is sequence-first on a terminal-only index

- **When:** Durable covering-terminal oracle.
- **The choice:** Event rows carry an internal terminal discriminator and are
  indexed by session and durable sequence. The query walks terminal rows after
  the submitted input and returns the first whose snapshotted accepted boundary
  covers it. Indexing boundary first could return the smallest sufficient
  boundary even when that terminal was recorded later, violating “earliest
  durable terminal.” Scanning ordinary transcript rows would make every recheck
  grow with history.
- **The constraint:** The lookup needed both efficient repeated rechecks and
  earliest-marker semantics.
- **The reach:** Future terminal observers reuse this projection instead of
  treating current session status or arbitrary history order as causality.
- **Verdict:** Sound — the index bounds repeated reads to terminal candidates and
  preserves durable event order as the selection authority.
- **Confidence:** High.
