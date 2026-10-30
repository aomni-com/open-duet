# Unprimed critique — the default agent's page beside a registered agent's

Run at close of the root-detail work. The reviewer was given only the two
desktop screenshots — `agent-detail.png` (a registered agent) and
`agent-detail-root.png` (the drive root) — described only as "two different
detail pages from the same web app", with no project context and no statement of
what the change was. It was asked whether they read as the same page design, and
which differences looked deliberate versus defective.

Verbatim result:

> Overall, they clearly share the same page design. Most differences are
> data-driven rather than structural defects.
>
> - **High — Both:** The Skills card is much narrower than every section below,
>   leaving a conspicuous empty right column. It looks like a missing companion
>   panel or accidental width constraint.
> - **High — Image 2:** A single small app tile sits inside a very large Apps
>   card, making the section look unusually empty or unfinished. Image 1 has the
>   same issue, but two tiles soften it slightly.
> - **Medium — Both:** Session dot colors have no legend or status labels. Their
>   meaning is ambiguous, particularly because several colors appear across the
>   pages.
> - **Medium — Image 2:** The AGENTS.md copy wraps awkwardly within a wide card
>   while most of the card remains empty. This makes the text column feel
>   arbitrarily constrained.
> - **Medium — Both:** Skill pills and secondary labels use very small,
>   low-contrast gray text. They are readable, but visually weak and their
>   clickability is unclear.
> - **Low — Headers:** Image 1 shows `research · agents/research`, while Image 2
>   shows only `Drive root`. This is likely deliberate nested-versus-root
>   context, though the differing breadcrumb format slightly weakens template
>   consistency.
> - **Low — Deliberate differences:** Avatar artwork, skill/app/session counts,
>   card heights, and AGENTS.md content all appear to be normal entity-specific
>   data, not defects.

## How this was read

The first line is the verdict the work needed: the two pages read as one design,
and the reviewer identified the header difference as deliberate without being
told it was.

Every finding marked "Both" is pre-existing on the registered-agent page that
shipped before this work — the narrow Skills card, the session-dot ambiguity, the
small low-contrast pills, the AGENTS.md wrapping. They are real observations
about the canvas, not regressions introduced here, and they belong to a design
pass over that canvas rather than to a naming feature. The single-tile Apps card
in image 2 is fixture data: the playground seeds one root-level app so the card
demonstrates something rather than reading "No apps yet".
