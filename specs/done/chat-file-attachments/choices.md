# Chat file attachments — final choices ledger

## Needs user

### Keep the model instruction direct and organizational

- **When:** runner-envelope implementation, retained at closeout.
- **The choice:** after each user message body, the agent sees: “Files the sender
  attached to this message, saved into your folder. Read them and organize them
  into your own structure.” Concretely, a person drops a brief into chat; the
  model is told both where it is and that `uploads/` is an inbox, not its final
  home. A softer alternative would list paths without telling the model to
  organize them, reducing behavioral pressure but leaving more inbox clutter.
- **The gap:** the product requirements said agents should read and organize
  attachments but did not settle exact model-facing prose.
- **The reach:** this sentence influences every attachment-bearing prompt, note,
  and answer, and therefore agent behavior beyond the transport itself.
- **Verdict:** needs-user — this is tone/product behavior. Recommended
  provisional call: keep it; reversing it changes one renderer string and its
  snapshots, without changing stored data.
- **Confidence:** medium.

## Sound

### Ambiguous submissions retain their exact landed paths

- **When:** whole-feature lifecycle review, commits `a7acc38c`–`fc6b501c`.
- **The choice:** imagine Send times out after the server may already have
  accepted a message. Duet records the exact paths submitted by that attempt and
  will not delete or move them during teardown or an agent switch. A later retry
  can be explicitly rejected without releasing paths protected by the earlier
  ambiguous attempt. The alternative—treat every client error as rejection—can
  leave an accepted message pointing at files the browser deleted.
- **The gap:** the plan described retry and removal but not ownership after an
  uncertain network result.
- **The reach:** this is the safety rule for idempotent retries, component
  unmounts, and target-agent changes.
- **Verdict:** sound — durable references win over cleanup when acceptance is
  unknowable.
- **Confidence:** high.

### A draft has separate commit, rejection, and discard outcomes

- **When:** whole-feature lifecycle review, commits `1e69d3a8`–`552b460a`.
- **The choice:** a successful send detaches local cards but keeps landed files;
  a confirmed 4xx rejection returns those files to the draft; discarding an
  unsent draft removes cards immediately and best-effort deletes bytes. An
  in-flight upload that finishes after discard deletes its final path. A single
  `clear()` operation could not express these different ownership transfers.
- **The gap:** teardown and success originally shared one cleanup verb.
- **The reach:** every composer surface and future attachment lifecycle must
  choose the real outcome instead of “clearing” blindly.
- **Verdict:** sound — the API now names the three materially different states.
- **Confidence:** high.

### Retry identity includes the input fields each route controls

- **When:** durable-model and closeout passes, finalized in `fc6b501c`.
- **The choice:** the same text sent through explicit session creation to another
  agent folder, or with a changed attachment list, gets a new client request id.
  An identical retry keeps the id and resumes/deduplicates the same server
  request. Default-session routes use the owning agent identity, because they
  derive cwd from that owner rather than accepting cwd from the browser. Without
  creation cwd and ordered file metadata in the identities that control them, an
  agent switch could return the old turn even though its paths describe another
  payload.
- **The gap:** existing retry identity covered text/images but not file paths or
  the folder where a new session is created.
- **The reach:** every input fingerprint includes ordered attachments; explicit
  creation and SPA retry behavior additionally include their canonical cwd.
- **Verdict:** sound — idempotency now means identical semantic input.
- **Confidence:** high.

### Upload grants use one neutral wire contract but separate credential stores

- **When:** upload-client implementation and whole-feature shape review.
- **The choice:** Train and Drive uploads share the same browser transport and
  `{ vmBaseUrl, uploadPath, uploadToken, expiresAt, prefix }` grant shape. They
  do not share stored grants: Train replaces one token per scope, while Drive
  keys grants by token hash so ten concurrent files cannot clobber one another.
  A single store would look simpler but inherit the wrong concurrency semantics.
- **The gap:** the plan required reuse of the proven rail without defining which
  layer was genuinely common.
- **The reach:** future direct VM uploads should reuse the neutral transport only
  after choosing their own authorization/store semantics.
- **Verdict:** sound — shared mechanics do not erase distinct capability rules.
- **Confidence:** high.

### Grant caching belongs to the generic transport and follows stable mint identity

- **When:** upload-client pass.
- **The choice:** one stable mint callback represents one logical upload scope.
  The transport caches its grant, renews thirty seconds before expiry, and
  deduplicates concurrent mint requests; adapters attach scope-specific headers.
  If each caller implemented caching, abort and renewal behavior would drift.
- **The gap:** the spec asked for a shared upload client but left cache identity
  and cancellation ownership open.
- **The reach:** Train and chat uploads now share renewal, XHR progress, and an
  abort that spans both mint waiting and byte transfer.
- **Verdict:** sound — one transport owns one network lifecycle.
- **Confidence:** high.

### File cleanup is immediate in UI and best-effort on Drive

- **When:** composer-state pass.
- **The choice:** pressing Remove drops the card and excludes the file from the
  payload immediately, then aborts or deletes remote bytes. If DELETE fails, an
  orphan may remain in `uploads/`, but the removed attachment never silently
  returns to the message. Waiting for DELETE would leave a visibly attached file
  after the person removed it.
- **The gap:** cleanup-failure UX was unspecified.
- **The reach:** user intent is authoritative; Drive hygiene may require later
  manual cleanup, except for paths protected by an ambiguous submission.
- **Verdict:** sound — reversible filesystem residue is safer than stale UI
  intent.
- **Confidence:** medium.

### Collision claims serialize naming, not file transfers

- **When:** composer-state pass.
- **The choice:** files in one draft take turns checking and claiming names, so
  two `brief.pdf` selections become `brief.pdf` and `brief (2).pdf`; their byte
  uploads then proceed concurrently. Re-homing recomputes names in the
  destination folder. Serializing whole transfers would avoid a small race with
  another browser but make a ten-file batch unnecessarily slow.
- **The gap:** the flat inbox decision specified suffixes but not concurrency.
- **The reach:** local batches are deterministic; separate composers retain the
  accepted last-write-wins race.
- **Verdict:** sound — serialization covers the shared decision and no more.
- **Confidence:** medium.

### Preview work is bounded and never blocks a valid attachment

- **When:** card implementation and whole-feature review.
- **The choice:** text/table previews read at most the first 4 KiB; image
  thumbnails are attempted only for supported formats under the inline-image
  size bound; failures fall back to a glyph. A 900 MiB file is still attachable
  without asking the browser to decode it merely because its MIME type says
  image.
- **The gap:** rich cards were required, but preview cost/failure semantics were
  not.
- **The reach:** transcript and composer cards remain orientation aids rather
  than document readers, with predictable memory/network cost.
- **Verdict:** sound — preview convenience cannot redefine file validity.
- **Confidence:** high.

### One shared card owns visuals; product surfaces own effects

- **When:** card implementation.
- **The choice:** `packages/ui` renders the filename, preview pane, metadata, and
  status hierarchy. The composer wraps it with retry/remove/progress; the
  transcript wraps it with Drive navigation and range fetching. Putting network
  effects in the shared component would make it know workspace routing, while
  copying cards into each surface would let them drift.
- **The gap:** “one card” did not settle the package boundary.
- **The reach:** new attachment surfaces inherit the visual language but must own
  their product-specific effects.
- **Verdict:** sound — it preserves one visual owner and clean dependency
  direction.
- **Confidence:** high.

### Gateway boot cleanup waits once and fails open per entry

- **When:** gateway pass and whole-feature review.
- **The choice:** before the first file request, the gateway scans only its
  private upload-temp directory and removes stale `upload-*` files. A malformed
  entry or deletion error is logged and skipped; it cannot poison all future
  file traffic. Both the grant and train credential stores use one fsynced,
  mode-0600 JSON persistence primitive.
- **The gap:** the plan required a sweeper and persistence but left failure
  isolation and ownership of the write primitive open.
- **The reach:** gateway restarts reclaim stranded bytes without turning cleanup
  into an availability dependency.
- **Verdict:** sound — bounded hygiene cannot become a global outage switch.
- **Confidence:** high.

### The staging journey follows product-owned observable boundaries

- **When:** live closeout, commits `82253837` and `7dd4325d`.
- **The choice:** uploaded file cards finish when `Ready` appears; inline images
  finish when `Preparing` disappears. Durable images are located through
  `data-message-inline-image`, not translated English copy. The first two live
  attempts proved that assuming one status or one label for every media type
  creates five-minute false failures even while the feature works.
- **The gap:** the journey initially guessed UI semantics rather than sharing
  the shipped surface contract.
- **The reach:** future locale changes and intentional image/file status
  differences do not weaken or randomly break deployed acceptance.
- **Verdict:** sound — tests observe stable behavior rather than presentation
  wording.
- **Confidence:** high.
