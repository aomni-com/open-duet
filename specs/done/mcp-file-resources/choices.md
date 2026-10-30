# MCP file resources — choices ledger

## Sound

### Transfer grants bind the authenticated actor for their entire lifetime

- **When:** final independent review.
- **The choice:** Both upload and download grants persist the actor derived by
  the API when the grant is minted. The gateway restores that actor for every
  authorized transfer and ignores a transfer caller's actor header. Outstanding
  actor-less upload grants fail closed across the hard cut.
- **The gap:** Direct generated-media uploads initially preserved the bytes but
  lost the OAuth caller at the API-to-VM handoff, recording the write as
  `system`.
- **The reach:** File history and seen-by report generated media and attachment
  uploads as the authenticated actor rather than the platform, while the
  opaque transfer credential remains the only header a direct uploader needs.
- **Verdict:** sound — identity is derived once from authentication and carried
  by the capability instead of trusting the transfer caller.
- **Confidence:** high.

### Public acceptance records end-to-end persistence time, not invented upload telemetry

- **When:** deployed closeout.
- **The choice:** A client can time `generate_media` from request to final
  ResourceLink and can time downloading the linked bytes. It cannot see when
  the server finishes model generation and starts the raw VM upload, nor can it
  inspect the remote MCP process's memory. The staging artifact therefore
  records the honest observable facts: generate-and-persist time, generated
  size, successful SDK/platform completion, a one-block result with no inline
  bytes, and bare-download times and hashes. It labels upload-only time as
  included in the whole tool call instead of fabricating a number.
- **The gap:** Acceptance called for upload duration and a memory/platform outcome,
  but the deliberately small public result exposes neither server phase timing
  nor server process telemetry.
- **The reach:** The MCP file API remains the same clean standard ResourceLink.
  Upload-only timing or process memory belongs in
  internal telemetry rather than fields every MCP client must receive forever.
- **Verdict:** sound — acceptance measures what the external contract can prove
  and does not distort that contract for one test.
- **Confidence:** high.

### Transfer connection failures use stable MCP error names

- **When:** durable generated-media implementation.
- **The choice:** A failed HTTP response already carries a useful API error such
  as `storage_full`, so MCP preserves it. A connection failure has no response
  body to preserve, so the MCP boundary uses a small operation-shaped name:
  `file_upload_grant_request_failed`, `file_upload_failed`, or
  `file_resource_request_failed`. If the bytes reached Drive but creating the
  final clickable reference could not connect, the error also returns the
  durable Drive path. A caller can retry `read_file` for that path without
  generating and charging for the media again.
- **The gap:** Recovery behavior and plural scope metadata were fixed, but the contract
  did not name errors for requests that fail before receiving HTTP.
- **The reach:** MCP clients can distinguish model failure from each storage
  stage, and a control-plane outage after upload never hides where the durable
  bytes landed.
- **Verdict:** sound — the names describe the failed operation, preserve real
  upstream errors when available, and add no retry protocol.
- **Confidence:** high.

### Reverse MIME lookup chooses the lexically first registered extension

- **When:** durable generated-media implementation.
- **The choice:** The shared Drive MIME table remains the only format owner. Its
  reverse helper normalizes a generated MIME type, gathers every registered
  extension for it, sorts those extensions, and uses the first. For example,
  `image/jpeg` becomes `.jpeg` and `application/yaml` becomes `.yaml` even if
  table order changes.
- **The gap:** The contract required one deterministic canonical extension but
  delegated the selection rule.
- **The reach:** Generated filenames stay stable across harmless table
  reordering, while adding or removing an alias remains an explicit contract
  change in the shared owner.
- **Verdict:** sound — it is deterministic, independent of insertion order, and
  adds no second MIME registry.
- **Confidence:** high.

### The runnable local media probe uses the repository's official SDK harness

- **When:** durable generated-media implementation.
- **The choice:** The generated-image/video probe drives the real MCP server
  through the official SDK's in-memory client transport. Its fake network
  asserts the model, API upload-session, raw VM PUT, and API file-reference
  order on their respective hosts, then prints only the final ResourceLinks.
- **The gap:** The spec required a mock MCP client but did not fix a second
  client package or script owner.
- **The reach:** Contributors get a fast runnable contract example without a
  new dependency, and deployed acceptance continues to use the same standards
  client over Streamable HTTP.
- **Verdict:** sound — one pinned client oracle covers both local and deployed
  protocol checks without introducing a parallel harness.
- **Confidence:** high.

### Raw Drive downloads use Bun's file-backed response body

- **When:** deployed generic-client acceptance.
- **The choice:** `serveDriveGet` now gives Bun a `Bun.file` body (or an exact
  file slice for a range) instead of adapting Node's `createReadStream` into a
  Fetch response. Both are streamed from disk, but Bun changes a Node stream
  response to chunked transfer and removes the explicitly supplied
  `Content-Length` at the real network boundary. The file-backed body preserves
  the ordinary full and range lengths through the deployed server.
- **The gap:** Handler-level tests saw the header before Bun serialized the
  response, so the first generic-client run proved bytes but did not prove the
  promised GET header.
- **The reach:** Authenticated files, exact-grant downloads, and public raw
  publishes continue to share `serveDriveGet`; all now preserve their declared
  response length without buffering the file in application memory.
- **Verdict:** sound — it fixes the existing byte owner at the network boundary
  instead of adding a client exception or another download route.
- **Confidence:** high.

### The generic MCP client gate uses the repository's pinned official SDK

- **When:** deployed generic-client acceptance.
- **The choice:** The automated external client is the official MCP TypeScript
  SDK version already used by Duet. It connects to the deployed MCP origin over
  the standard Streamable HTTP transport, validates the returned tool result
  against the SDK schema, and then downloads the linked file with ordinary HTTP.
  The alternative was adding MCP Inspector or another client dependency solely
  for this test, which would introduce a second version and another installation
  path without proving a different protocol contract.
- **The gap:** Acceptance required one generic standards client but delegated
  which client to use.
- **The reach:** The staging gate now fails if Duet emits a result the official
  SDK rejects, and generated-media checks reuse the same download oracle.
- **Verdict:** sound — it proves the standards seam with no new dependency or
  parallel client harness.
- **Confidence:** high.

### Focused staging journeys can be selected in the secret-bearing CI runner

- **When:** deployed generic-client acceptance.
- **The choice:** The manual staging workflow accepts an optional journey name.
  Supplying `mcp-oauth` runs only that registered journey; leaving it empty
  preserves the existing full acceptance run. For example, a workstation that
  lacks the staging decryption key can dispatch the focused gate in GitHub,
  where the repository secret already exists. The alternative was running the
  hour-long full suite despite the spec forbidding it, or copying a staging
  secret onto another machine.
- **The gap:** The repository supported focused journeys locally and a full CI
  workflow, but did not expose focused selection through the secret-bearing CI
  entry point.
- **The reach:** High-cost staging checks can run their registered
  journey without broadening secret distribution or weakening cleanup.
- **Verdict:** sound — the default is unchanged and the selector forwards only
  to the existing validated journey registry.
- **Confidence:** high.

### Declared text MIME types can make extensionless resources inline-readable

- **When:** MCP file-read implementation.
- **The choice:** The shared Drive classifier now considers both a file's name
  and the MIME type returned by the file API. A MIME type is the standard label
  describing bytes, such as `text/plain` or `image/png`. For example, an
  extensionless `README` labeled `text/plain` returns its complete text followed
  by its download link; `photo.png` labeled `image/png` returns only the link.
  A declared text resource whose bytes are not valid UTF-8 falls back to its
  link, so the caller can still download it instead of receiving fabricated
  text. The alternative was extension-only classification inside MCP, which
  would hide valid extensionless text and create a second rule beside the
  shared Drive classifier.
- **The gap:** Inline text and the shared classifier were fixed, but the contract
  did not say how authoritative MIME metadata or incorrectly labeled bytes
  should affect that decision.
- **The reach:** Every consumer can reuse one classification rule for a
  `FileResource`; MCP never needs its own growing MIME list, and a bad label
  cannot make the durable file inaccessible.
- **Verdict:** sound — it keeps classification centralized while treating the
  link as the reliable fallback when inline decoding is impossible.
- **Confidence:** medium.

### A failed metadata HEAD becomes a small typed API error, not a second file read

- **When:** public file-resource API implementation.
- **The choice:** Creating a file reference first mints its link and sends HEAD
  to that link. HEAD asks for headers only, so a missing file naturally returns
  a bodyless 404. The public POST translates that status into
  `{ "error": "not_found" }`; a directory conflict becomes `not_file`, and
  other failures become `gateway_failed`. It does not retry with GET merely to
  recover an error body. The alternative would make a failed metadata check
  perform a content-read request, which could race with a file appearing and
  would blur the rule that only successful GET represents a read.
- **The gap:** Existing failure statuses had to survive, but the contract did
  not say how a JSON-creating endpoint should represent bodyless HEAD errors.
- **The reach:** API and MCP callers receive useful JSON errors while HEAD stays
  activity-neutral and the happy path remains one metadata request.
- **Verdict:** sound — the mapping preserves the actionable status without a
  second operation whose semantics differ.
- **Confidence:** medium.

### Public transfer endpoint IDs use collection-create names

- **When:** public file-resource API implementation.
- **The choice:** The developer catalog calls the two operations
  `files.downloads.create` and `files.uploads.create`. An endpoint ID is the
  stable machine name used by generated docs and coverage checks, independent
  of its URL. The alternative was a grant-shaped name such as
  `files.downloadGrant`, which would expose the private credential mechanism in
  the public API vocabulary even though callers receive a file resource or an
  upload session.
- **The gap:** The paths and responses were fixed; their catalog IDs were not.
- **The reach:** Generated docs and SDK names describe what callers
  create rather than how the VM implements it.
- **Verdict:** sound — the IDs follow the existing category/action convention
  and keep grants private.
- **Confidence:** high.

### The VM has one kind-tagged Drive-grant mint endpoint

- **When:** Drive grant implementation.
- **The choice:** The private API-to-VM call is now `POST /v1/drive-grants`.
  Its request says either `kind: "upload"` with a folder prefix or
  `kind: "download"` with one exact file path. For example, the API that needs
  an upload sends the upload variant; the API that needs a clickable file sends
  the download variant. The removed endpoint name described uploads only, so
  keeping it after downloads existed would have made the shared owner look like
  an upload special case. The alternative was two VM endpoints that both mint
  records in the same credential store.
- **The gap:** The spec required one grant owner and a hard cut but did not name
  its VM-only mint route.
- **The reach:** Every Drive transfer grant uses this private seam, while
  public REST keeps separate upload/download endpoints because their OAuth
  scopes differ.
- **Verdict:** sound — one private endpoint mirrors the one persisted grant
  owner without weakening the two public authorization boundaries.
- **Confidence:** high.

### The gateway returns a VM-relative file path, not a guessed public URL

- **When:** Drive grant implementation.
- **The choice:** A download mint returns
  `/v1/files/<durable-path>?grant=<token>` plus its expiry. The API combines that
  path with the workspace VM's already-known public base URL. For example, the
  same gateway can run on loopback in a test and behind an exe.dev public proxy
  in production without being configured with either hostname. The alternative
  was making the VM gateway guess or learn its external origin and return a full
  URL itself.
- **The gap:** The spec fixed the final public `FileResource.uri`, but not which
  internal component joins the public origin to the granted path.
- **The reach:** The API remains the sole owner of workspace-to-public-VM
  resolution; gateway grant persistence and file serving stay deployment-URL
  agnostic.
- **Verdict:** sound — it follows the existing direct-upload contract and
  avoids a second public-origin configuration owner.
- **Confidence:** high.
