# Live file refresh choices ledger

## Sound

### Validate the wire shape while the gateway enforces file/non-file identity

- **When:** Slice 01 contract pass.
- **The choice:** The shared validator requires an explicit `etag` containing a string or `null`, while the authenticated gateway guarantees that regular files carry a string and non-files carry `null`. For example, a broken gateway that emits `{ file, etag: null }` would still pass the shape parser; the HTTP tests prove that the current producer emits a non-null file identity, but they do not make the parser reject that broken pair. The alternative was a cross-field schema refinement that duplicated the gateway's file-type rule in the validator.
- **The gap:** The plan assigned identity production to gateway helpers but did not say whether the runtime schema should duplicate producer semantics.
- **The reach:** Future authenticated file producers must preserve the same non-null invariant; clients continue treating the ETag as opaque rather than parsing its spelling.
- **Verdict:** Sound — the contract owns the transport shape and the gateway owns the semantic correlation, avoiding two independently maintained copies of the same producer rule.
- **Confidence:** Medium.

### Reuse the identity owner even though stat performs one extra local lookup

- **When:** Slice 01 gateway pass.
- **The choice:** The stat route first resolves ordinary presentation metadata, then calls the existing `fileEtag(path)` helper, which performs a bigint filesystem stat to produce the same version token used by content responses. If the file changes between those lookups, metadata and identity can briefly describe adjacent moments; the controller accepts the read response and lets a later stat reconcile metadata. The alternative was reshaping path resolution so one bigint stat supplied both metadata and identity.
- **The gap:** The plan required one identity owner but did not settle syscall count or how to bridge ordinary `Stats` to nanosecond `BigIntStats`.
- **The reach:** Every visible-file poll pays one cheap local stat, while stat, reads, and conditional writes cannot drift into separate ETag algorithms.
- **Verdict:** Sound — one version algorithm is more important than avoiding a local metadata lookup, and the controller contract already reconciles stat/read races.
- **Confidence:** Medium.

### Public stat deliberately carries no refresh identity

- **When:** Slice 01 browser-provider pass.
- **The choice:** Public stat returns `etag: null` for every entry, even when a single-file root already makes a ranged raw request whose response could contain an ETag. A public page therefore cannot accidentally use stat as a partial live-refresh source. The alternative was opportunistically returning ETags only for public paths that happened to make raw probes, leaving public identity availability inconsistent.
- **The gap:** The plan prohibited public polling and request changes but did not say whether an already-observed public response ETag should survive the stat projection.
- **The reach:** Public publishing stays outside the live controller. Any future public refresh feature must introduce an explicit, consistently available identity contract.
- **Verdict:** Sound — consistent `null` preserves the authenticated-only boundary and existing public request behavior.
- **Confidence:** Medium.

### Mock data URLs use a fragment as their source identity

- **When:** Slice 01 browser-provider pass.
- **The choice:** The mock provider returns `data:...#v=<encoded ETag>` when a version is supplied. Two accepted snapshots can therefore have different source strings while the fragment leaves the inline bytes untouched. The alternatives were blob URLs with cleanup ownership, mutating the data payload, or leaving the URL unchanged and proving refresh only through a renderer key.
- **The gap:** The plan required an identity-specific mock source but did not choose its URL scheme.
- **The reach:** Playground and renderer tests can drive the real URL-refresh path deterministically without network requests or object-URL lifecycle machinery.
- **Verdict:** Sound — the fragment is encoded, side-effect-free, and changes browser source identity without pretending to serve historical bytes.
- **Confidence:** Medium.

### Navigation discards loose stat ETags instead of becoming a snapshot cache

- **When:** Slice 01 browser-provider pass.
- **The choice:** Files and publish navigation immediately unwrap `stat.entry` and do not retain the returned ETag. Opening a file may observe a version tag, but that tag is not paired with accepted bytes yet; Slice 02's controller establishes the first complete `{ metadata, bytes, ETag }` snapshot itself. The alternative was threading the navigation ETag through view state as a second initial-version cache.
- **The gap:** The plan required direct stat-consumer cutover but did not say whether navigation state should carry an initial live identity.
- **The reach:** `useLiveFile` remains the sole authenticated remote-snapshot owner, and public navigation gains no new live state.
- **Verdict:** Sound — an ETag without its matching accepted bytes is not a snapshot, and duplicating it would create the parallel owner the spec forbids.
- **Confidence:** High.

### String and numeric URL versions share one encoder

- **When:** Slice 01 browser-provider pass.
- **The choice:** The REST client applies `encodeURIComponent(String(version))` to both new opaque ETags and existing numeric icon versions. Thus `7` remains `v=7`, while quotes, slashes, and question marks inside an ETag become one safe query value. The alternative was maintaining separate number and string branches.
- **The gap:** The plan required encoded strings and byte-identical ordinary numeric behavior but did not prescribe one encoding path or two.
- **The reach:** Future opaque version tokens inherit one query grammar, and numeric app-icon URLs keep their established spelling.
- **Verdict:** Sound — one encoder avoids divergent URL rules while preserving the existing numeric contract.
- **Confidence:** High.

### Mock writes keep presentation metadata stable while ETag changes

- **When:** Slice 01 browser-provider pass.
- **The choice:** A mock write changes bytes and ETag while retaining its deterministic `modifiedAt` date. Changing `first` to same-length `other` therefore gives the file a new accepted identity even though both size and displayed modification time stay still. The alternative was advancing the mock timestamp, which is more filesystem-like but would let a controller test accidentally refresh by mtime and still pass.
- **The gap:** The plan required realistic metadata and ETag-only freshness but did not say whether deterministic mock write times should advance.
- **The reach:** Slice 02 can use the mock as a controlled oracle: a refresh that succeeds must have compared ETag, not size or modified time. The date remains a valid `Date` for presentation tests.
- **Verdict:** Sound — stable non-identity metadata makes the central ETag-only rule observable and keeps playground data deterministic.
- **Confidence:** High.

### The concrete public provider exposes the shared optional argument

- **When:** Slice 01 integration review.
- **The choice:** `PublicFileSystemProvider.downloadUrl` accepts the optional version argument but consumes it without changing the returned `?raw` URL. Code typed as the concrete class and code typed as `IFileSystemProvider` can now make the same call. The first implementation omitted the argument from the class signature, which worked at runtime but forced concrete TypeScript callers to cast to the interface.
- **The gap:** The plan required the public provider to ignore versions but did not say whether its concrete TypeScript signature must remain directly substitutable.
- **The reach:** Preview code and fixtures can use any provider implementation without casts, while public URL/auth/request behavior remains unchanged.
- **Verdict:** Sound — the integration audit corrected the non-substitutable first pass before the slice checkpoint.
- **Confidence:** High.

### The scheduler is a class-backed external store with an injected runtime

- **When:** Slice 02 controller pass.
- **The choice:** A framework-neutral `LiveFileController` owns state and effects through injected clock, timer, and visibility functions; `useLiveFile` is only the `useSyncExternalStore` and lifecycle adapter. The alternative was React-owned timers and effects tested through a DOM hook harness.
- **The gap:** The plan delegated the timer/visibility injection technique but did not choose the owner shape.
- **The reach:** Race and cadence behavior is deterministic without a browser, while the mounted Files playground remains responsible for proving the actual React Strict Mode call path.
- **Verdict:** Sound — the scheduler has one owner, no renderer knowledge, and a narrow React boundary.
- **Confidence:** High.

### Snapshot loading is injected after stat resolves

- **When:** Slice 02 controller pass.
- **The choice:** The controller calls `loadSnapshot(entry, signal)` only after a changed non-null ETag. Slice 03 resolves presentation and chooses versioned versus ranged reads in that callback. The alternative was teaching the scheduler about file extensions and renderer load strategies.
- **The gap:** The controller needed content bytes but the plan explicitly kept presentation selection outside the scheduler.
- **The reach:** Every renderer shares one polling/race path, and future load strategies can change without branching the controller.
- **Verdict:** Sound — this preserves the controller/presentation ownership boundary.
- **Confidence:** High.

### Immediate reconciliation remains a controller-owned action

- **When:** Slice 02 integration review for Slice 03.
- **The choice:** The hook exposes `checkNow()` in addition to cold retry and local-save acceptance. It aborts stale work and starts one serialized visible check. The alternative was letting `PreviewPane` read directly after a save-time 412 or waiting ambiguously for the next cadence.
- **The gap:** Slice 02 named only retry/local-save actions, while Slice 03 requires `Reload latest` to fetch when the controller has not accepted the divergent remote snapshot yet.
- **The reach:** The action must stay scoped to explicit reconciliation; it is not a second refresh loop or a public-preview API.
- **Verdict:** Sound — the sole remote-snapshot owner remains responsible for every fetch.
- **Confidence:** High.

### Metadata reconciliation tracks the stat identity separately

- **When:** Slice 02 independent review.
- **The choice:** The controller remembers which stat ETag produced the accepted entry metadata. Ordinary same-ETag polls preserve the exact snapshot object; when stat v2/read v3 race, the next stat v3 replaces metadata once without rereading bytes. If a changed stat read races back to the already accepted content ETag, neither metadata nor the remote timestamp changes.
- **The gap:** The plan simultaneously required no same-identity snapshot replacement and next-poll metadata reconciliation after a stat/read race.
- **The reach:** Preview consumers do not rerender every two seconds or announce false updates, while Office size eligibility still converges after a real race.
- **Verdict:** Sound — the extra internal identity reconciles both invariants without exposing another cache.
- **Confidence:** High.

### Local save publication preserves the last remote acceptance time

- **When:** Slice 02 integration review.
- **The choice:** `acceptLocalSave` updates the accepted snapshot and invalidates stale remote work but retains `lastAcceptedAt`. The initial implementation advanced the timestamp to the save time.
- **The gap:** The plan called this the last remote acceptance time but did not spell out the local-save timestamp behavior.
- **The reach:** Slice 03 can drive `Updated just now` from one timestamp without mislabeling the user's own save as an external update.
- **Verdict:** Sound — local and remote acceptance remain semantically distinct while sharing one snapshot owner.
- **Confidence:** High.

### Live mode is an explicit preview capability

- **When:** Slice 03 preview integration.
- **The choice:** `PreviewPane` receives a discriminated live capability. Authenticated Files passes `{ enabled: true, onBackToFolder }`; public and publish callers pass or inherit `{ enabled: false }`. The alternative was inferring live behavior from provider type, route shape, or the presence of a workspace slug.
- **The gap:** The plan required authenticated-only polling but did not prescribe how callers declare that boundary.
- **The reach:** New preview entry points cannot accidentally poll merely because they reuse the provider interface; recovery navigation is available only where the authenticated surface owns it.
- **Verdict:** Sound — the product boundary is visible at every composition seam and remains independent of transport implementation details.
- **Confidence:** High.

### Draft conflicts are structural state, not component timing

- **When:** Slice 03 draft integration.
- **The choice:** Pure draft transitions own baseline ETag, dirty state, accepted remote bytes, and the shared conflict latch. Both remote divergence and a save error classified by status `412` plus code `precondition_failed` enter that state; no error-message matching remains. The alternative was coordinating several component booleans and treating the two conflict sources separately.
- **The gap:** The UI contract named one conflict experience but left its internal representation delegated.
- **The reach:** Reload and Replace reset the same baseline regardless of conflict source, and deferred-read races evaluate the draft at commit time.
- **Verdict:** Sound — one transition model pins the user-visible contract without turning `PreviewPane` into a second remote snapshot owner.
- **Confidence:** High.

### Accepted ETags version every URL-backed renderer source

- **When:** Slice 03 renderer integration.
- **The choice:** Image, PDF, video, and audio receive the provider URL with the accepted opaque ETag plus a structural source key `${path}:${etag}`. Byte-backed Office/text/hex presentations consume the accepted snapshot bytes directly. The alternative was renderer-specific refresh actions or using metadata such as size in component keys.
- **The gap:** The spec required a renderer matrix but left the shared source descriptor shape delegated.
- **The reach:** Same-ETag polls preserve source identity, while a changed accepted snapshot invalidates browser URL caches consistently without promising historical reads.
- **Verdict:** Sound — every renderer remains a passive consumer of one accepted snapshot.
- **Confidence:** High.

### Warm renderer swaps retain the last good presentation

- **When:** Slice 03 visual review.
- **The choice:** Images and video stage their next URL before switching the visible source; Word renders and sanitizes into a detached container before atomically replacing accepted markup. Spreadsheet selection clamps when refreshed workbook shape changes. The alternative was clearing the current renderer and showing the cold-loading treatment on every accepted ETag.
- **The gap:** The global invariant prohibited a warm loading flash, but the existing renderer components assumed one-shot input.
- **The reach:** An open preview remains useful while the next representation decodes/renders, and failed warm Word rendering does not destroy its last good page.
- **Verdict:** Sound — staging happens inside renderer ownership without creating fetches, timers, or parallel snapshot state.
- **Confidence:** Medium.

### Recovery states disable ambiguous mutation actions

- **When:** Slice 03 fresh screenshot critique and final independent code review.
- **The choice:** Save, Reload latest, and Replace file are disabled while the controller is reconnecting or missing, and their handlers independently refuse to run. For example, if a dirty conflict is visible when the remote file disappears, Replace file cannot quietly recreate the deleted path from stale browser text, and Reload latest cannot label the retained last-good bytes as current. Missing content is read-only and its Edit toggle is disabled while Preview and download remain available. A long dirty conflict keeps its draft scrollable and adds a bottom fade/continuation cue instead of clipping text into the dialog edge. The alternative was leaving controls active because the last-good snapshot still exists, or relying on disabled button styling without protecting the mutation handlers.
- **The gap:** The initial UI contract specified recovery copy and retained content, but not whether stale-content mutation affordances remain actionable.
- **The reach:** Users can inspect and recover without implying that a write is queued, recreates a deleted path, or is safe against an unobserved version. Future keyboard shortcuts or alternate controls must use the same mutation gate rather than bypassing the buttons.
- **Verdict:** Sound — the visible and programmatic guards enforce the same rule while preserving the draft until a current remote identity is known again.
- **Confidence:** High.

### Required browser entry types keep symlink previews one-shot

- **When:** Final independent code review.
- **The choice:** Browser directory entries require the contract's `file`, `directory`, or `symlink` type, and their discriminated shape keeps that type correlated with directory presentation. An authenticated symlink can still open and read through to its target, but `PreviewPane` does not attach the live controller to it because stat intentionally returns `etag: null` for the link itself. For example, opening `current.md` when it points at `notes.md` displays the target bytes once, exactly as before; it does not compare the target content ETag against the link's null stat identity. The alternative was retaining an optional type where an unknown entry silently behaved like a file, rejecting the preview, pretending the symlink was a regular file, or adding a separate target-resolution identity protocol.
- **The gap:** The ETag plan specified null identities for symlinks but did not say how an existing file-like symlink preview should behave after authenticated previews became live.
- **The reach:** Symlink reads remain compatible without weakening the rule that live refresh requires one non-null stat identity for the addressed entry. A future live-symlink feature must define what happens when either the link target or the target bytes change.
- **Verdict:** Sound — falling back to the established one-shot path preserves behavior and avoids comparing identities from different objects.
- **Confidence:** High.

### The staging proof reuses one path for recovery and exit

- **When:** Slice 04 staging harness pass.
- **The choice:** The focused journey creates one run-unique text path, mutates that path from outside the browser, deletes and recreates it to prove automatic recovery, then deletes it a second time to prove Back to folder. The preview page is navigated once; all later transitions must occur inside the already-open pane. The alternative was using separate files or browser reloads for conflict, recovery, and deletion, which would make each assertion easier but would not prove that one mounted controller survives the whole lifecycle.
- **The gap:** The plan required all transitions and preferred same-path recovery, but it did not prescribe whether they share one browser mount and one resource identity.
- **The reach:** Future staging failures can be localized to controller continuity rather than setup differences between several miniature journeys. The cleanup ledger owns the single synthetic file immediately after creation and treats deleting an already-absent path as success.
- **Verdict:** Sound — one identity and one mount are the smallest proof of the feature's defining continuity invariant.
- **Confidence:** High.
