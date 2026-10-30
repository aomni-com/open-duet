# Agent App Test Harness — Choices Ledger

## Sound

### Reconcile generated visual artifacts around approval

- **When:** Final visual approval review.
- **The choice:** Approval first writes the manifest-derived coverage ledger,
  then captures and safely prunes screenshots, then regenerates and verifies
  the combined visual-owner index. For example, when an author renames the
  representative `completed` scene, the old ledger must not stop Playwright
  before it can create the new PNG and remove the old one. The unbuilt
  alternative verified every old generated artifact before capture, which made
  the documented approval command incapable of converging that rename.
- **The gap:** The plan required exact generated coverage and safe pruning but
  did not specify phase ordering when approval itself changes those artifacts.
- **The reach:** Adding, renaming, and deleting scenes can converge through one
  full-owner approval command; check mode remains read-only and verifies every
  committed artifact.
- **Verdict:** **Sound.** Generated inputs are written before capture and the
  complete final state is verified afterward, so neither stale pre-state nor an
  unchecked post-state can pass.
- **Confidence:** High.

### Keep the corpus arrangement as code, not a fixture language

- **When:** Slice 03 — complete local corpus.
- **The choice:** Each scenario is a small TypeScript row whose arrange
  function calls the app’s public HTTP endpoints. Connected states change one
  shared fake Duet edge, while Connect Repos changes its injected probe. The
  unbuilt alternative was a general JSON fixture schema that would need to
  encode six unrelated APIs and then translate those fixtures back into HTTP.
- **The gap:** The plan fixed the public-HTTP rule and rejected a generic DSL,
  but left the internal organization of 22 arrangements to the implementer.
- **The reach:** A future scene adds one typed row and normal HTTP calls; runner
  code and production storage remain untouched.
- **Verdict:** **Sound.** The scenario registry is direct, typed, and no more
  abstract than the production differences require.
- **Confidence:** High.

### Treat a revoked code-host grant as incomplete

- **When:** Slice 03 — degraded Connect Repos baseline.
- **The choice:** A setup that was once completed becomes incomplete when its
  code-host connection is no longer connected, even if the old repo choice is
  preserved. Before this choice, a user could see “All set” beside “The GitHub
  grant was revoked”; the unbuilt alternative left those two claims visible at
  once.
- **The gap:** The app README said completion requires a connected host, but the
  existing state-settling code checked only whether a repo remained selected.
- **The reach:** Agents and users no longer treat a revoked grant as usable, and
  the retained selection can become complete again after reconnection.
- **Verdict:** **Sound.** It restores the documented completion invariant with
  one state condition and a public-HTTP regression test.
- **Confidence:** High.

### Separate Bun behavior discovery from Playwright visual discovery

- **When:** Slice 03 — package closeout.
- **The choice:** The browser loop uses a `.visual.ts` suffix selected explicitly
  by Playwright, while ordinary `bun test` continues to discover behavior tests.
  The screenshot path template keeps the existing `official-apps.spec.ts`
  directory stable. The unbuilt alternative let Bun discover Playwright’s
  `test()` calls and fail before running the package suite.
- **The gap:** Slice 02 established a `.spec.ts` tracer but did not reconcile it
  with this package’s broad `bun test` script.
- **The reach:** The behavior suite and visual suite can both run from their
  normal package commands without excluding directories or duplicating tests.
- **Verdict:** **Sound.** Each runner owns explicit discovery, while the public
  screenshot seam remains stable for Slice 04.
- **Confidence:** High.

### Run the visual process under Bun

- **When:** Slice 02 — simple local visual harness and tracer.
- **The choice:** The package invokes Playwright as `bun --bun playwright` so
  the test worker can start the production app factories in-process. The
  Playwright binary's default Node shebang cannot provide the `Bun.file` and
  `Bun.serve` APIs those factories use.
- **The gap:** The plan fixed the existing production factories and Docker
  runner, but did not specify which JavaScript runtime launches Playwright.
- **The reach:** Visual tests exercise the real server implementation without a
  sidecar process, supervisor, or browser-only substitute.
- **Verdict:** **Sound.** This is the smallest runtime correction that preserves
  both production fidelity and the current Playwright workflow.
- **Confidence:** High.

### Keep the production empty-state framing

- **When:** Slice 02 — visual review of the Account Board tracer.
- **The choice:** Accept the full-page desktop and mobile baselines unchanged.
  The fresh critic found clean reflow and no clipping, overflow, loading, or
  error residue; it noted only that the empty detail panel has substantial
  whitespace.
- **The gap:** The plan delegated visual acceptance but expressly excluded app
  redesign from the harness slice.
- **The reach:** The baseline records the app users actually receive instead of
  quietly redesigning it while adding test infrastructure.
- **Verdict:** **Sound.** The whitespace is a low-severity product-polish note,
  not a rendering or contract failure.
- **Confidence:** High.

### Pin the stable refusal code, not its explanatory sentence

- **When:** Slice 01 — Content Board behavior floor.
- **The choice:** When a card without a verdict tries to move from opportunity
  to keywords, the test requires HTTP 409 and the machine-readable
  `verdict_required` error. It does not require the accompanying human sentence
  to stay byte-for-byte identical. A future copy edit can therefore clarify the
  advice without weakening the gate; changing the error code or allowing the
  move still breaks the test.
- **The gap:** The plan required the exact rejected transition but did not say
  whether explanatory copy was part of that stable contract.
- **The reach:** Future Content Board copy can evolve independently, while API
  consumers and later visual scenarios can rely on the semantic error code.
- **Verdict:** **Sound.** Status plus the public error code pins the business
  rule without coupling behavior coverage to incidental wording.
- **Confidence:** High.

### Treat fixture cleanup as part of the test verdict

- **When:** Slice 01 — Content Board behavior floor.
- **The choice:** Cleanup callbacks run in reverse creation order and a cleanup
  failure fails the test. In the restart scenario, that stops the replacement
  server before the original fixture removes their shared temporary directory.
  The unbuilt alternative was concurrent best-effort cleanup, which could hide
  a leaked server or race directory removal against a still-running app.
- **The gap:** The plan required isolated temporary storage and cleanup but did
  not prescribe ordering or whether teardown errors affect the verdict.
- **The reach:** This test cannot report green while leaving its server or data
  behind, and later harness fixtures have a concrete lifecycle pattern to copy.
- **Verdict:** **Sound.** Resource isolation is observable test correctness, so
  teardown failures must remain visible.
- **Confidence:** High.

### Expose the loader as an opt-in package subpath

- **When:** Slice 05 workspace-loader pass.
- **The choice:** The reusable loader is imported as
  `@repo/test-harness/official-agent-workspace` instead of being folded into the
  package's broad root export. Concretely, the manual `try` script asks for this
  one orchestration tool and does not implicitly load every Convex, VM, OAuth,
  and staging helper exported by the test-harness root. The unbuilt alternative
  was to add it to that root barrel, making an unrelated developer script depend
  on the whole integration-fixture surface.
- **The gap:** The spec required an importable module under the test-harness
  package but did not choose its package export boundary.
- **The reach:** Future staging code can import the same narrow seam, while new
  loader dependencies remain visible instead of arriving accidentally through a
  catch-all package entry.
- **Verdict:** Sound — a dedicated subpath matches the loader's one named
  responsibility and avoids a thin re-export module.
- **Confidence:** High.

### Keep `try` progress incremental by calling the shared loader per agent

- **When:** Slice 05 workspace-loader pass.
- **The choice:** When a person runs `bun run try alpha beta`, `try` invokes the
  shared loader for `alpha`, prints alpha's result immediately, then does the
  same for `beta`. The loader itself also accepts multiple agents for the future
  staging journey. The unbuilt alternative was one all-agent loader call from
  `try`; if beta failed, alpha would already be installed but its success line
  would never have printed because results would return only after the whole
  batch.
- **The gap:** The spec required unchanged human-readable output and sequential
  loading but did not state whether successful earlier progress must be printed
  before a later agent fails.
- **The reach:** Manual multi-agent runs retain their existing progress and
  failure visibility, while automation can still request one sequential batch.
- **Verdict:** Sound — it preserves the command's observable behavior without
  duplicating transfer or registration mechanics.
- **Confidence:** High.

### Fit complete baselines in the generated contact sheet

- **When:** Slice 04 — fifth visual owner review.
- **The choice:** Generated contact-sheet thumbnails use containment rather
  than cropping each image to a fixed landscape frame. The initial fresh critic
  rejected the report because desktop edges and most of every tall mobile shot
  were hidden even though the source PNGs were correct.
- **The gap:** The existing union index optimized a dense overview, but the new
  owner includes full-page mobile documents whose semantic state often sits
  below the first screenful.
- **The reach:** All visual owners now show the complete baseline in the index;
  clicking still opens the full-resolution source. Filenames wrap without
  truncation.
- **Verdict:** **Sound.** A visual review index must not conceal parts of the
  evidence it asks a reviewer to judge.
- **Confidence:** High.

### Derive deployed readiness from each app's authored page

- **When:** Slice 06 — official-agent app staging journey.
- **The choice:** The journey reads each generated `page.html` to learn its
  visible heading and whether its settled state is represented by a connection
  pill or a visible empty-state panel, then waits for loading/checking copy to
  leave. For example, a newly added
  connection app carrying the same waiting-pill pattern is checked without
  adding its slug to a second staging table. The unbuilt alternative was a
  six-row staging locator roster that would need to be updated separately from
  both the manifest and the app source.
- **The gap:** The plan delegated exact stable locators while forbidding a
  second app roster; it did not choose how one generic journey discovers the
  app-owned default-state marker.
- **The reach:** A new manifest app enters the deployed journey automatically
  when it follows either existing page contract. A genuinely new presentation
  contract must extend this small structural derivation instead of silently
  escaping semantic checks.
- **Verdict:** Sound — the evidence comes from the generated production bytes
  being installed, and the browser still proves the derived marker inside the
  real private iframe.
- **Confidence:** Medium.

### Name disposable staging images from manifest identities

- **When:** Slice 06 — official-agent app staging journey.
- **The choice:** Screenshot names use the stable manifest agent/app pair, while
  routes use the API-returned slugs. If a dirty workspace forces `board-2`, the
  evidence still says which authored app was tested and separately records that
  `board-2` was the address actually opened. The unbuilt alternative named files
  from collision-dependent returned slugs, making two otherwise identical runs
  produce different artifact inventories.
- **The gap:** The plan fixed image count and evidence mapping but delegated
  artifact field and filename details.
- **The reach:** Contact-sheet assembly and human comparison stay stable across
  runs without weakening the API-authoritative route proof.
- **Verdict:** Sound — source identity is the durable label and returned identity
  remains explicit evidence rather than being discarded.
- **Confidence:** High.

### Unlock app-onboarding agents through the existing public endpoint

- **When:** Slice 06 — official-agent app staging journey live correction.
- **The choice:** After registration, the journey reads generated `agent.json`
  files to identify agents whose setup is itself an app, then sequentially marks
  those returned agent identities onboarded through the existing public API. It
  still opens and asserts the onboarding apps in their safe disconnected state;
  marking the agent complete only removes the product-shell lock that otherwise
  substitutes the onboarding app when another app, such as Content Board, is
  requested. The unbuilt alternative was to initiate provider authorization or
  hard-code SEO Specialist as a special case.
- **The gap:** The plan required both onboarding and ordinary sibling apps to be
  addressable in one cold workspace but did not say how the product's onboarding
  lock should be satisfied without OAuth.
- **The reach:** Any future app-onboarding agent is unlocked from its authored
  config without joining a staging roster. The fixture changes only ephemeral
  agent completion metadata; its workspace cleanup removes that state.
- **Verdict:** Sound — it reuses the product endpoint already exercised by the
  staging onboarding journey and preserves the disconnected app contract.
- **Confidence:** High.

### Bound the ephemeral workspace identity to the manifest's hostname budget

- **When:** Slice 06 — official-agent app staging journey live correction.
- **The choice:** The shared workspace-browser fixture accepts an optional slug
  already supported by login-as, while only the official-app journey supplies
  one. That journey hashes a per-run nonce and spends the available DNS-label
  budget after deriving the longest app slug from the production manifest. The
  unbuilt alternative changed the platform hostname grammar to accommodate a
  test fixture's verbose generated name.
- **The gap:** Login-as normally derived a workspace slug from the descriptive
  run label. `connect-search-console--<derived-workspace>` reached 64 bytes and
  failed DNS resolution even though registration and reconciliation succeeded.
- **The reach:** Every current manifest app gets a deterministic-format,
  run-unique ephemeral host label of at most 63 bytes, while all other journeys
  retain their existing identity policy and cleanup path.
- **Verdict:** **Sound.** It uses an existing validated API seam, retains strong
  collision resistance, and keeps platform routing untouched.
- **Confidence:** High.

### Defer the general maximum-slug hostname mismatch

- **When:** Slice 06 — DNS failure investigation.
- **The choice:** Record, but do not redesign, the fact that two public
  40-character slugs cannot fit the reversible `app--workspace` single-label
  hostname format. The discarded paths were lossy truncation, a second parser,
  or new lookup-backed opaque hosts.
- **The gap:** The harness failure revealed a broader schema/routing boundary,
  but the requested slice owns fixture coverage rather than production address
  architecture.
- **The reach:** A future platform task must choose the durable hostname
  contract explicitly; this harness pass must not be mistaken for that fix.
- **Verdict:** **Sound.** Deferring avoids embedding an unchosen compatibility
  layer in a staging-test correction.
- **Confidence:** High.

### Stack provider actions in the product's narrow app frame

- **When:** Slice 06 — fresh staging screenshot critique.
- **The choice:** At the product frame's 188-pixel mobile width, each onboarding
  provider row places its badge or button below the provider name. Wider layouts
  remain unchanged. The unbuilt alternative accepted one-word status slivers
  and buttons drawn over provider labels because standalone 390-pixel baselines
  did not reproduce the narrower deployed frame.
- **The gap:** Local app screenshots covered the agreed phone viewport, while
  the product shell gives its embedded app less than half that width. The live
  journey made the missing responsive boundary visible.
- **The reach:** All four onboarding apps keep labels and controls readable in
  the real mobile composition, at the cost of more vertical scrolling for long
  provider lists.
- **Verdict:** **Sound.** A geometry regression pins non-overlap at the actual
  frame width, and a fresh before/after critique found no residual overlap,
  clipping, or horizontal overflow.
- **Confidence:** High.

## Unsound

None.

## Needs user

None.
