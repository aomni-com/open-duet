# Drive deep links — implementation choices

This ledger records decisions the implementation had to make where the binding
map and sliced plan did not fully determine the answer. Entries are grouped by
verdict and ranked least-confident-first within each group.

## Sound

### Retry only the mount reached from a successful share acceptance

- **When:** Slice 07 closeout review.
- **The choice:** The accepted destination is carried in React Router history
  state and enables a bounded resolver retry only when that exact path is
  current. Ordinary cold missing URLs still settle immediately as not-found.
  The unbuilt alternatives would either poll every stale link or navigate once
  before the VM had materialized the accepted mount.
- **The gap:** The slice required a fresh landing but the accept endpoint's
  anchor reconcile is bounded best-effort and may return before the directory
  exists.
- **The reach:** Same- and cross-workspace accept landings wait up to ten
  seconds behind the existing loading presentation, remain refreshable, and
  retain the dedicated not-found state after the bounded retry expires.
- **Verdict:** **Sound.** The retry is tied to explicit successful acceptance
  provenance instead of weakening the global 404 contract.
- **Confidence:** High.

### Make live stale-link recovery selectors independent of locale

- **When:** Slice 09 closeout review.
- **The choice:** The not-found presentation exposes stable semantic data
  attributes for its state and recovery action; the staging harness uses those
  rather than English copy. The unbuilt alternative would fail deterministically
  because this browser is still in the earlier Spanish locale when the new leg
  runs.
- **The gap:** The slice prescribed English locator examples without accounting
  for the existing staging journey's locale order.
- **The reach:** Copy remains localized and editable while the required live leg
  can prove the same interaction in either supported locale.
- **Verdict:** **Sound.** It separates automation identity from translated
  presentation without changing pixels or accessible names.
- **Confidence:** High.

### Re-derive the emitted-link grammar in the staging harness

- **When:** Slice 09 (`6c85d06f`).
- **The choice:** The harness owns an independent exact-href oracle whose case
  table mirrors the web grammar; it does not import application builders. The
  rendered link is selected by both its run-unique display name and its actual
  files href because the agent-page link deliberately has the same text.
- **The gap:** Importing app code would turn the acceptance check into
  self-confirmation, while text alone cannot distinguish the two required
  links.
- **The reach:** The trace proves that a live agent emitted the folder link and
  that the browser clicked that literal link, including root-relative,
  per-segment encoding.
- **Verdict:** **Sound.** Independent derivation makes grammar drift visible and
  avoids synthetic acceptance evidence.
- **Confidence:** High.

### Delay the same-workspace remount until its accepted path is current

- **When:** Slice 07 (`80fa775a`).
- **The choice:** A same-workspace accept arms the target path in a ref and
  increments the Files provider revision only after navigation settles there.
  If the target is already current, the revision increments immediately. The
  unbuilt alternative remounted at the old root and started a stale listing
  before the replace-navigation arrived.
- **The gap:** The plan named the revision/navigation ordering risk but left its
  choreography delegated.
- **The reach:** Accepted shares do not flash or fetch the old folder, and the
  remount still refreshes app projection and file state together.
- **Verdict:** **Sound.** It keeps route state authoritative while preserving
  the existing remount refresh seam.
- **Confidence:** High.

### Keep emitted session-link styling with the shared renderer

- **When:** Slice 08 visual review (`fcb83197`).
- **The choice:** The new Drive link uses the existing session-authored Markdown
  link presentation. Fresh critique found links insufficiently distinct from
  prose, but direct comparison showed that styling predates this feature and is
  owned by the shared renderer. The unbuilt alternative would redesign all
  authored links inside a link-contract slice.
- **The gap:** Adding a second link made existing renderer debt more visible.
- **The reach:** The emitted contract ships without unrelated session-message
  visual drift; link affordance remains a separately scoped renderer decision.
- **Verdict:** **Sound.** The link is semantically correct and visually
  unchanged apart from the required extra line.
- **Confidence:** High.

### Keep agent-link visual evidence focused on the changed affordance

- **When:** Slice 06 visual review (`ba1b2759`).
- **The choice:** The new `agent-anchor-link` baseline isolates the detail
  header link at both viewports instead of rewriting historically stale broad
  agent-detail shots whose roster data has changed for unrelated reasons.
- **The gap:** The existing full-canvas baselines no longer isolate the one
  intended pixel change.
- **The reach:** Review evidence pins the underline/focus affordance while the
  stale broad-baseline cleanup remains separate maintenance.
- **Verdict:** **Sound.** It gives the feature precise visual ownership without
  laundering unrelated snapshot drift.
- **Confidence:** High.

### Keep slice checkpoints on the feature worktree

- **When:** Foundation maintenance checkpoint after slices 00–03.
- **The choice:** Each pass is committed on `codex/drive-deep-links`; it is not
  pushed directly into `origin/staging` while later dependent slices are still
  under construction. The plan inherited a “push to origin/staging at every
  progress point” instruction, but the user explicitly created an isolated
  worktree for this feature. The unbuilt alternative would expose each
  intermediate seam on the shared staging branch before its consumers exist.
- **The gap:** The plan did not reconcile its direct-push sentence with the
  user-requested feature worktree.
- **The reach:** Every remaining pass inherits one reviewable feature branch;
  promotion to shared staging remains an explicit integration action rather
  than a side effect of a local checkpoint.
- **Verdict:** **Sound.** It preserves isolation and the user’s branch boundary
  without weakening the per-slice commit discipline.
- **Confidence:** High.

### Give browser and anchor path conversion one byte-preserving web owner

- **When:** Slice 01 (`6f5f2e7c`, `84db475a`).
- **The choice:** `apps/web/spa/files/lib/paths.ts` owns both
  `browserPathFromAnchorPath` and `anchorPathFromBrowserPath`. A file literally
  named `100%.pdf` remains `/100%.pdf` in browser-path form and is emitted as
  `100%25.pdf`; a literal anchor segment `a%2Fb` remains `/a%2Fb` rather than
  becoming `/a/b`. App rows and the share dialog use the new reverse seam
  instead of the older recursively decoding contract helper. The unbuilt
  alternative would make those consumers disagree with deep-link parsing
  about file identity.
- **The gap:** The plan named the forward conversion owner but described the
  older recursive decoder as its inverse even though percent-bearing names
  contradict that claim.
- **The reach:** All web-side path conversion now shares one exact dialect
  owner. Slice 09’s independent staging oracle must mirror the canonical URL
  case table rather than import either implementation.
- **Verdict:** **Sound.** It preserves exact identity in both directions while
  leaving the firewalled contract package untouched.
- **Confidence:** High.

### Reject non-canonical browser strings instead of silently rewriting

- **When:** Slice 01 integration audit (`84db475a`).
- **The choice:** `anchorPathFromBrowserPath` rejects relative paths, doubled
  or trailing separators, backslashes, and NUL characters rather than
  normalizing them into a different path.
- **The gap:** The plan required exact round-trips but did not state whether
  malformed browser-path strings should be repaired or rejected.
- **The reach:** Rows, share-dialog links, and the resolver cannot accidentally
  target a different filesystem object after lossy cleanup.
- **Verdict:** **Sound.** Rejection protects the path identity invariant and
  leaves recovery to the explicit not-found flow.
- **Confidence:** High.

### Keep malformed route input inside the not-found recovery state

- **When:** Slice 02 and its integration audit (`3fdddc04`, `84db475a`).
- **The choice:** When the route parser returns `null`, `resolveFilesView`
  performs no provider request and returns a not-found state whose
  `requestedPath` and `parentPath` are both `/`. When a non-null string is
  malformed, it is retained as `requestedPath`, recovery clamps to `/`, and no
  provider request occurs. The unbuilt alternative would widen the settled
  union with router-only sentinels or erase the URL that failed.
- **The gap:** The plan fixed root recovery for malformed input but left the
  settled `requestedPath` representation implicit.
- **The reach:** Slice 04 can offer deterministic root recovery without adding
  malformed-path branches throughout the controlled surface, while still
  showing the user which path failed.
- **Verdict:** **Sound.** It keeps the router sentinel at the resolver boundary
  and preserves the declared string-only settled state.
- **Confidence:** High.

### Keep settled route metadata separate from mutable folder entries

- **When:** Slice 04 (`ace2fa62`).
- **The choice:** `FilesSurface` retains the latest settled `FilesView` as the
  source of status and `folderPath`, while its existing mutable `entries` state
  remains the source for optimistic rename/delete behavior. The unbuilt
  alternative would either duplicate route metadata across primitive states or
  force every optimistic mutation to reconstruct the resolver union.
- **The gap:** The slice delegated the controlled surface's internal
  decomposition while requiring both resolver ownership and the existing
  optimistic mutation semantics.
- **The reach:** Folder-scoped operations now consume one resolved
  `folderPath`; slice 05 can open `previewed` from the settled file view without
  changing how mutations stage row updates.
- **Verdict:** **Sound.** It gives URL resolution one owner without coupling
  optimistic presentation edits to provider re-resolution.
- **Confidence:** High.

### Preserve the live five-control toolbar in new folder baselines

- **When:** Slice 04 visual checkpoint (`ace2fa62`).
- **The choice:** The new nested-folder and dotfile-folder baselines keep the
  shipped Hidden control at both viewports. An older desktop `files-browse`
  baseline predates that control but remains within the suite's tolerated pixel
  threshold; this slice does not rewrite that wider stale baseline set. The
  unbuilt alternative would make new route states omit a live control solely to
  resemble an outdated reference image.
- **The gap:** The binding slice required presentation parity but the historical
  desktop reference did not exactly represent current production presentation.
- **The reach:** New deep-link coverage reflects the actual toolbar. Retiring
  the tolerated historical desktop baseline drift remains separate visual-test
  maintenance rather than feature behavior.
- **Verdict:** **Sound.** Current code and mobile references agree on the
  five-control contract, and the feature firewall forbids a toolbar redesign.
- **Confidence:** High.

### Keep route resolution stable across callback identity changes

- **When:** Slice 05 (`14cebd60`).
- **The choice:** `FilesSurface` reads the latest navigation callback through a
  ref for the warm deleted-preview repair rather than making callback identity
  part of the resolver effect. The unbuilt alternative would restart a cold
  file resolution whenever a router-free owner recreates its callback, which
  can erase the settled-file evidence needed to distinguish warm deletion from
  a cold missing URL.
- **The gap:** The plan required router independence and warm-versus-cold
  behavior but did not prescribe callback identity semantics for controlled
  owners.
- **The reach:** Real router and playground owners may use ordinary inline
  callbacks without turning a presentation rerender into a new filesystem
  resolution.
- **Verdict:** **Sound.** Path and provider remain the only resolution inputs;
  navigation is an effect output and always uses the latest owner callback.
- **Confidence:** High.

### Model history explicitly in the router-free Files fixture

- **When:** Slice 05 (`14cebd60`).
- **The choice:** The Files playground keeps a tiny push/replace/index history
  model around the controlled surface instead of mounting a router or reducing
  navigation to a single path setter. The unbuilt alternatives would either
  violate the router-free mount invariant or leave Back reopening and
  replace-on-delete untestable at the component boundary.
- **The gap:** The plan required history choreography in a router-free
  playground but delegated the fixture mechanism.
- **The reach:** The same visual scenario proves push, replace, Back, and
  Forward semantics without giving `FilesSurface` knowledge of React Router or
  browser globals.
- **Verdict:** **Sound.** It tests the public controlled contract directly and
  keeps fixture-only history outside production ownership.
- **Confidence:** High.

### Leave preview-toolbar and binary-renderer styling unchanged

- **When:** Slice 05 visual review (`14cebd60`).
- **The choice:** The new deep-file and dotfile baselines retain the existing
  mobile icon-only History action and the existing extensionless-file hex
  renderer. Fresh critique identified ambiguity and weak visual prominence but
  no blocker; direct comparison found no modal regression. The unbuilt
  alternative would turn a navigation-only slice into a shared preview-toolbar
  or renderer redesign.
- **The gap:** New deep-link states exposed existing responsive and binary
  presentation debt that the slice's visual firewall did not ask to repair.
- **The reach:** Deep links ship with presentation parity. Improving mobile
  action labels or extensionless text detection remains separately scoped
  visual/product work.
- **Verdict:** **Sound.** The behavior under test is provenance and history;
  preserving the shared preview contract avoids unrelated visual drift.
- **Confidence:** High.

### Decode URL transport exactly once and never reinterpret logical filename bytes

- **When:** Literal-percent contract correction after user authorization.
- **The choice:** A path already obtained from JSON, storage, a filesystem
  listing, or a decoded request is a logical filename and keeps every percent
  sign literally. A raw HTTP suffix is split into segments and decoded exactly
  once before the same traversal checks run. For example, `%2e%2e/secret` is a
  traversal attempt and is rejected, while `%252e%252e/secret` names an
  in-Drive folder literally called `%2e%2e`; no later layer decodes it again.
  Malformed encodings and decoded separators retain the gateway's existing
  opaque `404 {"error":"not_found"}` response. Public publish anchor headers
  remain logical identities while only their nested raw URL suffix uses the
  transport decoder.
  The unbuilt alternative would keep recursive decoding and make literal
  percent-looking filenames impossible to distinguish from separators.
- **The gap:** The binding browser grammar required literal-percent identity,
  but the original slices explicitly excluded the backend boundary and did not
  define how double-encoded traversal-shaped names should behave once that
  boundary was authorized.
- **The reach:** Files, shares, anchors, agents, apps, Train inputs, attribution,
  and publishes now share one logical identity rule; only authenticated and
  public raw file URLs use the transport decoder.
- **Verdict:** **Sound.** Security comes from one decode followed by lexical and
  realpath containment, while filename bytes remain stable across every
  non-URL boundary.
- **Confidence:** High.

### Prove percent identities inside the required deployed browser journey

- **When:** Slice 09 literal-percent correction (`1cc282ba`).
- **The choice:** The existing required Drive deep-link leg creates two
  run-unique text files under its registered agent anchor: one with a literal
  percent and one whose name contains the literal characters `%2F`. It writes
  them through the authenticated raw-URL API, opens their independently encoded
  browser URLs, asserts distinct preview contents, reloads each URL, and records
  both files in the cleanup ledger. The unbuilt alternative would add another
  live leg or accept unit-level URL round-trips as deployed evidence.
- **The gap:** The original live leg proved an ordinary agent folder link but
  did not cross the real API/gateway/browser boundaries with either canonical
  percent-bearing identity.
- **The reach:** One deployed journey now proves producer encoding, API proxy
  preservation, gateway decoding, filesystem identity, SPA resolution, refresh
  persistence, and cleanup for both cases.
- **Verdict:** **Sound.** The proof extends the existing product journey without
  creating a second workspace, agent, or acceptance owner.
- **Confidence:** High.

### Give focused browser journeys separate API and browser credentials

- **When:** Post-close staging journey organization.
- **The choice:** A focused journey creates one synthetic owner and workspace
  through the programmatic staging login, but mints separate credentials for
  API orchestration and the browser cookie. The API credential creates and
  polls the agent session; the browser credential is free to follow the web
  session lifecycle without invalidating that poller. The unbuilt alternative
  would reuse the complete suite's email sign-in machinery or let browser
  session rotation couple otherwise independent control paths.
- **The gap:** The user selected a reusable workspace-browser fixture profile
  but did not prescribe how that fixture should authenticate its two clients.
- **The reach:** Future journeys using this profile avoid AgentMail and Stripe
  setup while retaining isolated credentials, run-tagged ownership, artifact
  redaction, and verified cleanup.
- **Verdict:** **Sound.** Each credential has one owner, and the focused fixture
  depends only on the services its selected journey actually exercises.
- **Confidence:** High.

### Refuse focused evidence from a stale gateway release

- **When:** Post-close staging journey organization.
- **The choice:** A focused journey waits until its new workspace reports the
  exact gateway version announced by the deployed staging API before invoking
  the feature oracle. Merely reaching an active VM is not enough. The unbuilt
  alternative would start sooner but could pass against an older in-VM gateway
  while the app and API already serve a newer staging release.
- **The gap:** Independent slices trade time and money against confidence; the
  user chose smaller slices but did not explicitly define whether mixed-release
  staging counts as evidence.
- **The reach:** A focused green has the same release-coherence meaning as the
  complete suite. During a rollout, the slice may stop at setup and clean up
  rather than produce misleading feature evidence.
- **Verdict:** **Sound.** The selected journey is cheaper, not weaker: it removes
  unrelated fixtures without relaxing the deployed-version contract.
- **Confidence:** High.

## Resolved

### Treat browser URL round-trip as proof of file API identity

- **When:** Slices 01 and 05 (`6f5f2e7c`, `14cebd60`), discovered in the final
  independent review.
- **The choice:** The implementation accepted browser builder→parser
  round-trips and mock-provider previews as proof that literal-percent names
  were addressable end to end, while leaving the backend/contract firewall
  untouched.
- **The gap:** The existing gateway applies recursive percent decoding at the
  raw file-path boundary. `100%25.pdf` becomes a decode error and `a%252Fb`
  becomes `a/b`; the browser identity cannot reach the same filesystem object.
- **The reach:** Normal agent/share paths work, but the binding canonical cases
  `100%.pdf` and `a%2Fb` do not. Correcting this safely affects the file API and
  its traversal defenses, which the current spec explicitly excludes.
- **Resolution:** The user authorized the contract/backend boundary expansion.
  Commits `54f1412a`, `cecc7f50`, `4be6e6f6`, `0d44c9c8`, `f915853f`, and
  `1cc282ba` implement and pin the exact-once transport boundary through every
  affected producer and consumer.
- **Verdict:** **Resolved.** The browser cases now reach distinct filesystem
  identities, and encoded separator/traversal probes remain rejected at raw URL
  boundaries.
- **Confidence:** High.
