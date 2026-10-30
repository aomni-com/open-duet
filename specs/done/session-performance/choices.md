# Session performance choices

These decisions apply to the integrated P44–P48 implementation.

## Human payload previews

- **Decision:** Limit each diagnostic payload (combined tool output, input,
  details, task chunk, or settlement result/error/reason) to 1 KiB of encoded
  JSON. Keep small object fields intact and trim large strings; if structure
  alone cannot fit, show an omission marker. Local execution and checkpoint
  data remain complete.
- **Gap:** The audit did not allocate a shared budget across input, details,
  and output. Each gets its own small allowance so a large input cannot erase
  a useful result; a tool event can therefore carry up to roughly 3 KiB of
  these payloads plus identity/status metadata.
- **Rationale:** One existing publication owner repairs both new and queued
  events. Trimming payload copies removes permanent size failures without
  changing the recovery policy for transient API failures.
- **Consequence:** Expanded tools display the stored preview. There is no
  second client trim, full-payload fetch, or historical Convex rewrite.

## Replay budgets

- **Decision:** History and live replay share one byte-budgeted database reader.
  History still encodes its existing opaque cursor; live replay still resumes
  after the last delivered numeric sequence.
- **Gap:** The audit required bounded reads without prescribing a new paging API.
- **Rationale:** The existing history reader already accounts for database and
  response limits before scanning. Reusing it avoids two divergent safety rules.
- **Consequence:** Large stored events produce shorter pages, with unchanged
  order, authorization, and reconnect behavior; small-event pages remain batched.

## Closed tool bodies

- **Decision:** Native disclosure state controls whether a tool payload mounts.
  Opening uses the latest stored preview; closing releases the body.
- **Gap:** The audit left the lazy-render mechanism unspecified.
- **Rationale:** Native details keeps its keyboard semantics and appearance;
  retaining hidden bodies or adding a second full-output endpoint is unnecessary.
- **Consequence:** Expansion pays formatting cost only for the selected tool.

## Relay history and live updates

- **Decision:** Preview diagnostic values in relay history, including nested
  completion/reactivation reasons, on both persisted events and immediate live
  document updates. Preserve machine definitions, identity, progress and status.
- **Gap:** The first audit traced task chunks but not their independent history
  and terminal copies; the live buffer also publishes before ledger storage.
- **Rationale:** A script result must not regain its full size through a second
  path. One publication normalizer serves both paths while the ledger receives
  the original event for its complete private recovery checkpoint.
- **Consequence:** Human relay history uses the same previews as tool parts.

## Incremental browser history

- **Decision:** A browser-cache-only generation marks ordered canonical appends.
  Replacements and older-page insertion reset it. The projector applies new
  canonical events, indexes tool replacements, and rolls back only touched live
  tail slots before reconciling provisional frames.
- **Gap:** Immutable cache arrays change identity on every append, so array
  identity alone cannot prove that a known prefix is unchanged.
- **Rationale:** The cache already owns append versus replacement semantics;
  reusing that fact avoids rescanning the whole prefix just to verify it. Full
  replay remains the fallback for genuinely changed historical ordering.
- **Consequence:** Projection work follows new events. Ordinary immutable array
  copying remains; no new public API, persisted backend field, or alternate
  client data store is introduced.
