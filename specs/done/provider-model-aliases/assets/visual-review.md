# Visual evidence

Target: preserve the three familiar router choices, disclose four provider
aliases in Advanced, show backing models and the user-approved comparison ratings, and keep
selection reachable by mouse, keyboard, and touch. Expanded options must be fully
readable within the standard 390×844 phone capture; smaller screens may scroll.

The original checkout failed the new Docker interaction test because Advanced
was absent. The implemented selector passed 61 affected web interactions and
four docs captures. An existing marker test was corrected to inspect visible
radio choices: its previous page-wide CSS query also counted deliberately hidden
Advanced rows. The accessible router choices remain exactly three when collapsed.

The first neutral visual critique identified the old mobile sheet height cap
hiding the final alias and a desktop settings submenu touching the viewport edge.
A new assertion reproduced the final option's viewport ratio of zero. Raising the
sheet cap to 90dvh and adding eight pixels of submenu collision padding produced
green assertions. The final four screenshots and zoomed crops received a fresh,
unprimed critique with no concrete visible defects. Keyboard and touch behavior
are established by the browser tests rather than inferred from screenshots.

[Before/after telemetry](comparison.json) records actual pixel changes, including
the initially added mobile Advanced control and the subsequent layout correction.
[The mobile comparison](mobile-layout-comparison.png) shows why the larger sheet
is less wrong: every alias is readable. The unchanged closed settings and agent
surface shots are expected; disclosure changes the open menu, not idle surfaces.
The final desktop settings submenu retains a visible bottom viewport margin.

Documentation crops preserve the changed prose and model IDs. A separate neutral
review found no overflow or overlapping controls. Inline IDs may wrap at hyphens
on narrow screens; allowing that is preferable to horizontal overflow and does
not change their text. Full-page regression snapshots remain owned by docs.

The four final picker captures were opened together in Preview for a non-blocking
review while closeout work continued. The accepted judgment is based on captured
pixels, passing interactions, and independent critique.

No review feedback arrived during the approximately five-minute window. The
final candidate was accepted on the evidence above and Preview was closed.

## Approved ratings follow-up

The user subsequently requested the existing cost/speed/intelligence points for
provider aliases and approved the numbers in the contract metadata. Final images
in `after/` and `crops/` show this scored version; `before-scores/` preserves the
previously accepted unscored design. The score-optional branch was removed.

The added points initially truncated the desktop settings label. A rendered-text
width assertion reproduced that failure; widening the settings trigger fixed it.
All four aliases can be selected, their accessible score labels are present, and
320/390-pixel touch checks prove complete selected-label visibility. The desktop
submenu is wide enough for label and metrics, while retaining its viewport margin.

The final independent critique inspected eight full/control shots and four zooms.
It found no clipping, overlap, or alignment defects. It noted the small pale `/5`
suffix on mobile; the primary score and icon remain readable, and this preserves
the existing router score presentation. No new metric style or scale was invented.

Forced capture also revealed stale pre-existing agent-surface copy in unrelated
baselines. Those snapshots were restored rather than folding a chat-copy refresh
into this feature. The unchanged composer-ready capture had zero pixel distance
and was likewise retained. The desktop Advanced-menu capture was intentionally
updated because its prior below-tolerance difference had left Advanced absent.

The scored screenshots were also opened together for approximately five minutes.
No feedback arrived; the evidence-based decision was retained and Preview closed.
A subsequent deployed 320-pixel check found the longest selected label three
pixels short of fitting. Reducing the compact metric group spacing by two pixels
per gap preserves the existing type sizes and gives the label the needed room.
The touch regression now checks that longest label as well as the final option.

The exact narrow framing was recaptured at 320 CSS pixels and DPR2 before and
after. Matching header crops establish the change independently of the rest of
the page. A fresh neutral review accepted the after image: the full label is
visible, all three scores remain distinct, and shared mobile contact sheets show
no metric-layout regression. All changed mobile snapshots were inspected.
