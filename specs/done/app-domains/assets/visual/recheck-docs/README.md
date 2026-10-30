# Recheck documentation visual evidence

The target is readable guidance for observing a manual domain recheck: full
responses expose `checking: true` for queued/running work on active or failed
bindings, active hosts keep serving, and completed observations omit the flag
and advance `lastCheckedAt`. Initial setup retains its lifecycle states.

The retained before/after captures use the same pinned Docker runner and optimized
static page. Natural page growth is expected. `comparison.json` records dimensions,
content hashes, changed overlap pixels and crop bounds; native comparisons put the
earlier page on the left. Both full pages retain the endpoint cards and footer.

The exact `docs-apps` red reproduced the new paragraph on desktop and mobile:
height grew by 126 and 236 pixels. The unchanged page prefix is byte-identical
through rows 2805 and 4553 respectively. Own inspection of every changed full
capture and domain crop found readable text and inline code, consistent spacing,
and no overlap or horizontal clipping. The added guidance is closer to the target
than the earlier omission; pixel distance only locates the shifted content.

Docs tests passed (4 cases, 19 assertions), together with content, boundary,
endpoint coverage and visual coverage. The root visual union passed. Docker
preflight also passed docs/UI typecheck and lint, static build and build-output
verification. No live services or full root test run were used for this prose edit.

The first history-free critique found no clipping, overflow or broken inline-code
wrapping. It raised long desktop lines, small inline code and weak headings;
before/after inspection shows these belong to the unchanged shared docs style.
The reported crop/viewport mismatch is framing: the desktop crop is a native
1080-pixel-wide rectangle inside the same 1440-pixel-wide page, not a second
viewport. These observations do not justify a shared typography change here.

The critic could not verify distant full-page content at thumbnail scale, so
additional native crops cover both callouts, one complete endpoint card on each
viewport, the mobile code block and both footers. The callouts, mobile code block
and footers are pixel-identical to their correctly shifted earlier regions.
Endpoint card content and layout are unchanged by inspection, with small raster
differences recorded separately rather than claimed identical.

The second history-free critique confirmed no concrete usability defect in the
native callouts, cards, code block, footer or domain copy. Its speculative mobile
path overflow concern prompted an additional native crop of the POST recheck card,
the longest path on this page. Own inspection confirms the path wraps at `/recheck`
inside its box on mobile; full card labels and values remain readable. Retained
before crops show the existing component's same wrapping behavior.

The final independent path critique accepted the longest endpoint card: no
clipping, overflow or legibility issue on desktop or mobile. Its bottom-space and
path-padding observations are cosmetic shared styles already visible before the
edit and in adjacent cards. Parent inspection confirmed this triage. All three
raw critiques are retained alongside the exact images they reviewed.

The exact `bun ui:approve docs-apps` approved only the reviewed desktop/mobile
baselines; their SHA-256 hashes match the retained and critiqued candidates.
The final exact `bun ui:check docs-apps` passed both viewport checks, including
production preflight and the unchanged visual union. Screenshot comparison
tolerances and unrelated baselines were not changed.
