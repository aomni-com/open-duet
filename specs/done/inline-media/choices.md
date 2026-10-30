# Choices ledger — inline-media (final, consolidated 2026-07-23)

Every decision made on Example User's behalf that was not in MAP.md or the slice
files, re-audited against the final shipped code. Grouped by verdict,
least-confident first. Scope note: the image rebuild, prod promotion, live
staging proof, and full e2e were cancelled/deferred by Example User directly — his
calls, not audit items.

**Review these first:** the two needs-user entries below — the scheme-less
prompt origin and the spinner-lookalike video asset.

## Needs-user (decide; provisional calls already applied)

- **The prompt introduces Duet as `Duet (service.example.invalid)` — without `https://`.**
  *(landed: closeout fix `4792fcba` · confidence: medium)*
  The approved S1 text read `Duet (https://service.example.invalid)`. When the root gate ran,
  the boundary rule `legacy-product-origin` — which exists because bare
  service.example.invalid is still the **v1 chat app's** origin, and v2 code must not point
  at it — found that exact URL inside the built gateway bundle and failed
  the build. What ships today: the prompt says `Duet (service.example.invalid)` (name only,
  no scheme), which passes the gate unweakened. The unbuilt alternative:
  keep the full URL and carve a one-line exemption into the boundary
  checker for the prompt constant. Gap: the walk approved the wording
  before anyone knew the gate scanned built artifacts. Reach: whatever an
  agent tells users about "where Duet lives" comes from this sentence.
  Provisional call: scheme-less. To reverse: add the gate exemption and
  restore the URL — one-line change each side.

- **The demo video's first frame contains an arc that looks like a buffering
  spinner.** *(landed: slice 04 · confidence: medium)*
  The playground fixture needed a deterministic video file, so the
  implementer generated one whose opening frame includes a dark partial
  circle over the chart art. An unprimed reviewer flagged it as "is the
  player stuck buffering?" — it isn't; it's drawn content inside the asset.
  What ships: the asset as generated, baselines approved over it. The
  unbuilt alternative: regenerate the clip without the arc and re-approve
  both baselines (~10 minutes). Gap: the slice delegated fixture-asset
  specifics. Reach: every future review of these baselines re-asks the same
  question. Provisional call: keep it; regenerate if it produces a second
  confused review.

## Sound (acknowledge — architecture you now own)

- **The web's VM-layout guard greps source, not built output.**
  *(slice 05 · confidence: medium)*
  The slice wanted proof the browser bundle never contains
  `/home/synthetic-user/drive` or a `DRIVE_ROOT_PATH` import. What ships:
  `no-vm-layout-in-web.test.ts` scans the SPA *source tree* — where such an
  import would have to live — rather than the compiled bundle. A transitive
  leak through some future re-export would evade it; nothing does today.
  Corrected escalation path if that ever worries you: a build-output grep in
  `verify:build-output`.

- **Literal-`%` filenames stay unservable everywhere — deliberately not
  fixed here.** *(review pass · confidence: medium)*
  Codex review noticed a file literally named e.g. `100%.mp4` 404s through
  the new absolute-path route. Tracing showed it 404s through the
  *relative* route too, and always has: the contract's bounded
  percent-decoder (the double-encoding defense) rejects any string still
  containing `%` after decoding stabilizes. Decision shipped: leave the
  product-wide policy untouched rather than smuggle a decode-policy change
  into this feature. Reach: agents should percent-encode, and `%`-named
  files won't render anywhere in the files surface either.

- **Media identity is guaranteed by the shared Markdown component, not by
  each consumer.** *(slice 04 + integration · confidence: high)*
  While a message streams, react-markdown re-parses the text on every
  chunk. The shared component used to define its default paragraph/anchor
  renderers as fresh inline functions per render — a new component type
  each time, so React tore down and rebuilt everything inside every
  paragraph, restarting any playing video. Codex had papered over this with
  a session-local copy of the paragraph renderer; the shipped fix moves
  stability into `markdown.tsx` itself (module-scope defaults + a memoized
  merge), so all six Markdown consumers inherit stable DOM identity. A
  Playwright test pins it: playback state survives a streamed tail.

- **The session cwd is canonicalized before joining; the agent's path never
  is.** *(review pass · confidence: high)*
  A session's working directory can legally be non-canonical (`a/../b`
  passes the schema; the agent actually runs in `b`). The gateway rejects
  any `..` it sees, so joining markdown paths onto the raw cwd made every
  relative image in such a session a dead link. Shipped rule: the trusted,
  schema-bounded cwd collapses its `..` segments client-side; the
  agent-authored src keeps its `..` verbatim and the gateway judges it —
  never silently clamped into the drive.

- **One bounded decoder, exported from the contract.** *(slice 05 +
  integration · confidence: high)*
  The gateway's new prefix-strip needs to percent-decode exactly the way
  the path normalizer does (same passes, same failure rules), or the two
  drift into a security seam. Codex shipped a byte-identical private copy;
  the consolidation replaced it with one exported owner,
  `decodeDrivePathBounded`, used by both.

- **Absolute-path admission lives only on authenticated reads.** *(slice 05
  · confidence: high)*
  GET/stat/list accept a VM-absolute path under the live drive dir; writes,
  deletes, JSON file actions, and the anonymous publish surface stay
  strictly drive-relative. Reach: anything that later wants absolute-path
  writes is a deliberate new decision, not an accident.

- **Drift in the prompt text is caught by sentence pins, not a byte
  snapshot.** *(slice 01 · confidence: high)*
  The prompt-constant test asserts each section's distinctive sentence plus
  size bounds instead of one frozen byte-blob. Reformatting stays cheap;
  losing a section still fails. The S1–S6 labels from the draft were
  dropped as review scaffolding — the prose is the contract.

- **File-card taxonomy reuses the Files surface's `fileKind`/`FileGlyph`.**
  *(slice 04 · confidence: high)*
  Cards in chat show the same icons/kinds as the drive browser — one
  vocabulary, no parallel mapping to maintain.

- **Extensionless drive-ish links keep SPA-link behavior; only file-like
  final segments become cards.** *(slice 04 · confidence: high)*
  `[Research](/w/acme/agents/research)` still navigates in-app;
  `[report](/home/synthetic-user/drive/report.pdf)` becomes a download card on a
  native anchor (the SPA link hook would otherwise swallow same-origin file
  URLs into the router). The boundary is "does the last path segment have
  an extension."

- **Dead links render as dead, everywhere.** *(slices 03–05 · confidence:
  high)* Outside-drive paths, `.duet` paths, traversal — the frontend
  resolves them into URLs that 404 and renders the natural broken state,
  rather than detecting and suppressing them client-side. The gateway is
  the single judge of servability.

## Discretion (delegated by the slices; no review needed)

Fourteen cosmetic/internal calls: media element styling (max heights,
`preload="metadata"`, `playsInline`), card spacing/labels
(`KIND · path` secondary line, `data-session-file-card` hook), test fixture
assets and step names, helper naming, probe-test placement, argv position,
snapshot string form, dotfile classification (`.gitignore` → file card),
`svg` counted as image (safe under the files route's CSP sandbox), and the
`%2F`-only leading-slash wire format chosen among several surviving
encodings (recorded as binding in slice 00's Finding).

## Closeout pass (close-spec, audited post-hoc)

- **Slice 00's hop-by-hop measurement tables were deleted with the slice
  ladder.** *(close commit `dac69756` · confidence: medium-high)*
  The probe slice's Finding section contained detailed tables of what every
  proxy hop did to five candidate encodings. At close, the ladder was
  collapsed; the tables now live only in git history
  (`git show cff35dd1:specs/inline-media/slices/00-abs-path-probe.md`),
  while the README keeps the conclusion and points at the probe tests —
  which still executably pin the same facts. Unbuilt alternative: keep the
  tables as an evidence appendix in the closed record. Verdict: sound — the
  tests are the living evidence; prose tables would drift.
- **Where a claim auditor and observed reality disagreed, observed reality
  won.** *(close commit `dac69756` · confidence: high)*
  An auditor asserted the `legacy-product-origin` gate "does not scan built
  artifacts"; this session had watched it flag `apps/api/dist/
  gateway-release/index.js`. The closed README describes the gate by the
  observed behavior (it scans the on-disk `apps/api/` tree, which includes
  that bundle). Verdict: sound — a reviewer's reading of the scanner lost to
  a reproduced failure.
- **The feature worktree and branch were left in place after the close.**
  *(post-close · confidence: high)*
  `Example User/inline-media` is fully merged; the worktree at
  `.claude/worktrees/inline-media` was kept for Example User to inspect rather than
  auto-removed. Reverse: `git worktree remove` + branch delete, zero risk.
