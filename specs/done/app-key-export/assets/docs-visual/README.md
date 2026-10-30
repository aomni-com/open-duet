# External app credential documentation: visual evidence

Target: keep the existing docs typography, navigation and endpoint-card layout
readable on desktop and mobile. The new prose must explain external hosting,
server-side export setup and the shared app identity/lifecycle without clipping
or horizontal page overflow.

## Captures and comparison

The four accepted regression baselines live with their docs owner:
`apps/docs/tests/visual/__screenshots__/{desktop,mobile}/docs.spec.ts/`
(`docs-apps.png` and `docs-api-keys.png`). Historical baselines remain available
in commit `9bc5d3063`, before this screenshot approval. The prose source changed
in `8f30ca5e7`. No layout, screenshot tolerance or capture-cap code changed.

| Capture | Historical height | Candidate height | Width |
| --- | ---: | ---: | ---: |
| Desktop Apps | 9,053 | 10,804 | 1,440 |
| Desktop API keys | 2,587 | 2,879 | 1,440 |
| Mobile Apps | 14,016 | 16,384 (cap) | 390 |
| Mobile API keys | 4,031 | 4,597 | 390 |

Both captures use the existing pinned Playwright `1.61.0-jammy` Chromium image,
optimized static export, desktop 1440×900 and mobile 390×844 viewport settings.
The native changed-prose crops retain the original pixel scale. Diagnostic
comparison pads the shorter image at the bottom with white to match dimensions;
it does not resize either page. `comparison-metrics.json` records the actual
pixel movement: distance is diagnostic, not a visual acceptance threshold.

The Mobile Apps page is 16,824 pixels tall; the existing regression cap is
16,384. `mobile-docs-apps-tail.png` supplements global y=13,324–16,824,
including the final endpoint cards and footer. `mobile-tail-dimensions.json`
records viewport width and document scroll width both equal to 390. The changed
external-hosting prose and export/list/revoke endpoint cards fall within the
normal capture. The tail is evidence, not a second catalog fixture or a claim
that the capped baseline captures the entire page.

## Visual judgment

A fresh reviewer inspected all four full candidates, all four changed-prose
crops, and the mobile tail. No blocking clipping, overlap, navigation, contrast
or endpoint-card defects were found. The writer independently checked the
same full set and native crops.

| Relationship | Historical/candidate observation | Judgment |
| --- | --- | --- |
| Content column and navigation | Existing desktop column/sidebar and mobile browse bar remain intact | Pass |
| Changed prose boundaries | Headings and paragraphs have visible separation on every side; no overlapping cards or labels | Pass |
| Inline code and links | Long phrases wrap at spaces; each identifier/value remains visible and legible | Pass |
| Endpoint cards | New export/list/revoke paths fit the cards; mobile paths wrap inside their own bounds | Pass |
| Lower mobile Apps page | Cap ends early; supplementary native tail shows final cards and complete footer | Pass with stated capture limit |

The reviewer noted two minor tradeoffs: the desktop inline command can wrap
between `duet` and `app credentials export`, and the mobile header can wrap
between `x-duet-tier:` and `services`. These are ordinary whitespace boundaries,
not clipped or broken identifiers, and preserve the established inline-code
layout. The reviewer also found the multi-paragraph credential lifecycle section
dense on mobile; its heading, paragraph spacing and links retain the existing
docs hierarchy. These notes do not justify a layout change for this content edit.
Static screenshots do not prove interactive menu/copy/disclosure behavior.

## Verification

The initial focused Docker check failed for the four intentional content
changes, establishing that the source reached the production render path.
Approval updates only those four baselines. The exact focused Docker check passed all four approved snapshots (4/4);
its successful preflight included docs/shared-UI
coverage, owner union, optimized docs build/build-output validation, typecheck
and lint. No full visual sweep was run. Both owner coverage ledgers and the root union
passed; the union contact sheet needed no content change.

A five-image Preview set showed both changed prose pages in both viewports plus
the mobile Apps tail. It was closed after the nonblocking review checkpoint.
The change remains limited to four truthful baseline updates and this evidence.
