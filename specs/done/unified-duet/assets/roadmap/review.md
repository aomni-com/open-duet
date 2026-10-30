# Roadmap verification

Target: show all eleven steps in order, readable descriptions and acceptance
controls, with no clipping. Collapsed cards support scanning; expanded cards
expose evidence gates without turning the roadmap into the full spec.

The independent screenshot critique found uneven desktop acceptance-control
positions and cramped narrow columns. The candidate aligns collapsed controls
within each desktop row (measured top spread: 0px) and uses one column at 648px.
DOM checks found scrollWidth equal to viewport width at 1280px and 648px.
All eleven details opened together; their links point to the owning slices.

Matched desktop before/candidate captures and matched 648px expanded captures
are retained here. Narrow page height intentionally increases with the single
column; full-frame distance is not an acceptance metric for that layout change.
Capture metadata records dimensions and differing content hashes. A second
neutral critique judged both candidates less wrong with high confidence and
found no remaining blocking clipping, overlap or contrast defect. The longer
narrow page is an accepted readability tradeoff.

Static verification: eleven slice files, 49 Markdown link targets and all HTML
slice/spec targets resolve; source-reference JSON parses; roadmap JavaScript
passes node --check; no trailing whitespace. These are plan/artifact checks.
No harness parity, packaging, image, registry or fleet verification was run.
