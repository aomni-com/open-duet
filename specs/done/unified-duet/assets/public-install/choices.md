# Public install choices

## Keep one install-copy owner

**When:** slice 09 public installation pass.

**Decision:** The rendered install page, install.txt and generated agent-readable page continue to call the existing shared copy functions. The alternative would duplicate new commands and prerequisites in each surface.

**Gap:** The user requested one repo and release owner without specifying how public instructions should share content.

**Rationale:** These surfaces are different presentations of the same instructions. Reusing their existing owner avoids another independently maintained package name or login example.

**Consequence:** A later prerequisite or command change reaches each install presentation together. No new runtime or content registry was added.

## Preserve machine configuration during email login

**When:** executable public-example tracer.

**Decision:** The email exchange reads the existing saved configuration and replaces its login, chosen default workspace and API origin. A missing configuration starts empty. The alternative was the old example's unconditional replacement of the whole file.

**Gap:** The user required the same credential for CLI and sync; the behavior of manually executed public email instructions on an already configured Mac was unspecified.

**Rationale:** The machine ID belongs to the computer, rather than the key. Overwriting the file would abandon that identity during an ordinary sign-in. The test executes the published Node code with a synthetic response and scratch home, proving the old ID survives and the secret is not printed.

**Consequence:** Email login follows the ordinary CLI's preserved-configuration behavior. Invalid existing JSON remains an explicit error rather than silently discarding local state.

## Explain delegated grants separately from human access

**When:** identity documentation sweep.

**Decision:** Human access follows current membership and role, while installed apps and OAuth retain their explicit delegated grants. The alternative would describe every credential as unrestricted user identity.

**Gap:** The user simplified human credentials; they did not request removal of installed-app or OAuth delegation.

**Rationale:** The canonical security model and actual request contracts distinguish a person from delegated software. Clear prose removes the retired human scope picker without promising account access to an app.

**Consequence:** Consumers reuse a human login across operations and sync, while integrations still declare their supported boundaries. No new consent or scope interface was introduced.

## Keep established visual owners and add bounded full-page evidence

**When:** visual verification pass.

**Decision:** Update the existing changed-route baselines and supplement the install fold captures with full-page evidence. The alternative would create a new permanent visual route or broaden all lander baselines to full-page captures.

**Gap:** The user did not specify a new visual layout or screenshot-coverage design.

**Rationale:** The existing owners already assert actual route rendering and document overflow. Below-fold code needs inspection, but does not justify another maintained fixture or an unbounded site-wide capture expansion.

**Consequence:** Future normal checks retain the same route IDs and viewport baselines. The evidence records this pass's full instructions without changing the visual harness contract.

## Superseding visual coverage choice after fresh critique

**When:** final visual critique follow-up.

**Decision:** The install code block now has one presentation owner used by all four public examples and by a new bounded `lander-install-code` playground fixture. The fixture renders the actual long email example. This supersedes the copy-only pass's choice to rely exclusively on full-page evidence.

**Gap:** The initial copy work did not change the code presentation. The fresh critique then exposed obscured docs lines and undiscoverable mobile scrolling in the install blocks.

**Rationale:** Wrapping solves the install problem without requiring readers to discover horizontal scrolling. Moving docs copy controls into normal layout prevents overlap for every example. A real shared presentation change deserves recurring below-fold coverage; the existing install route captures only the fold. The fixture adds two bounded screenshots rather than broadening every public route to full-page captures.

**Consequence:** Commands retain their exact text and native copy semantics. Install code becomes taller on narrow screens; numbered step comments are emphasized for scanning. A future code presentation change reaches every example and the same fixture. The existing expanded mobile navigation capture remains intentional, with a close-and-reopen check proving the reader can return to the heading.

## Preserve source words and production fixture context

**When:** final readability and fidelity follow-up.

**Decision:** Natural wrapping preserves identifiers. Actual examples use multiline shell/JS formatting where possible; remaining long literals scroll with a visible cue and native keyboard access. This supersedes forced arbitrary wrapping. The fixture now selects the same plain utility context as the public install page rather than inheriting marketing colours and narrower framing.

**Gap:** The first wrapping pass exposed complete characters but could split identifiers. The existing playground shell assumed every fixture used the marketing palette.

**Rationale:** Correct executable text must also remain readable as code. This approach preserves complete source words and copied bytes without reducing font size or inventing replacements for long IDs. The probe demonstrates that font families and weights already match; the actual frame differences are corrected directly.

**Consequence:** Rare long literals require horizontal scrolling, with an explicit cue and tested keyboard access. Code examples may be taller from authored line breaks. Utility fixtures can now use their real production context while existing marketing fixtures retain their original frame and baselines.

## Retain the existing documentation disclosure

**When:** third fresh visual critique.

**Decision:** Keep the existing mobile documentation disclosure without adding an arrow.

**Gap:** The critic identified medium-confidence discoverability uncertainty from static closed captures; no failed navigation interaction was reported.

**Rationale:** Source inspection confirms a native details/summary control with the action label “Browse documentation”, a separately styled current-route title and pointer cursor. The maintained production browser journey opens it, confirms navigation appears, closes it, proves the heading is visible and restores the intended expanded capture. This is an existing page-navigation presentation rather than a newly introduced control or a concrete regression.

**Consequence:** No site-wide navigation or baseline change is added to the CLI consolidation. A future usability finding can revisit its disclosure styling; the current interaction remains covered.
