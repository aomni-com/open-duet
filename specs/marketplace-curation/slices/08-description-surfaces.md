# 08 — Description on detail + settings (visual slice: the description body)

**Slice variable:** the description body and the settings card order. Cards
(06) and sectioning (07) are out of scope.

**Contract unlocked:** the marketplace detail page and the agent settings
page render the same long-form content (ledger #6): DESCRIPTION.md when
present, full AGENTS.md otherwise. Settings shows description on top, Skills
at the bottom (ledger #10).

## API seam

- NEW shared `apps/web/spa/agents/agent-description.tsx` —
  `AgentDescription({ markdown: string | null })` over the common `Markdown`
  component, owning the empty state. Consumed by BOTH surfaces so drift is
  structurally impossible.
- `detail-page.tsx`: `detail.description` becomes the primary body section;
  changelog stays as its own "What's new" section after it. (No hero banner —
  ledger #7 keeps the agent-page hero deferred.)
- `agent-profile.ts`: NEW `agentDescriptionQueryOptions` — **one queryFn**:
  read `DESCRIPTION.md` via the files API (`joinDrivePath`, `retry: false`),
  on 404 read `AGENTS.md`, on second 404 return `null`. Never two racing
  queries. If the canvas was `agentReadmeQueryOptions`'s only consumer,
  DELETE it (and its query key) in this slice — no dead owner survives the
  swap; keep it only if a real second consumer exists.
- `agents.tsx` route + `agent-detail-canvas.tsx`: `agentsMarkdown` prop
  becomes `descriptionMarkdown`; the description `DetailCard` moves to the
  top of the canvas, Skills card to the bottom; the stale `"AGENTS.md"` card
  title is replaced with description-oriented copy — new i18n keys in
  `duetApp.agentDetail`, **en + es-419**.

## Human-visible

An agent with DESCRIPTION.md: settings and its marketplace detail show
identical prose; delete the file (locally): settings falls back to the whole
AGENTS.md. Playground fixtures for: description present, fallback, both
absent, settings order (description top / skills bottom).

## Verification

- Query unit test: DESCRIPTION.md present → its bytes, exactly one request;
  404 → AGENTS.md bytes, exactly two; both 404 → null.
- `agent-detail-canvas.test.tsx` + `marketplace.test.tsx` updates; i18n
  parity test.
- ui-playground baselines for both surfaces (mobile shell shots pin content
  via DOM asserts, per the prior playground resolution; `ui:approve --force`
  for sub-threshold diffs, byte-diff the PNG).
- **compare-screenshots** against the prior detail/settings layouts (judging
  the body region and card order only); unprimed **screenshot-critique** as
  the last check on accepted shots.

## Explicitly out of scope

Card art, featured section, any hero/banner on either page.

## Delegated to implementer

Empty-state copy, section heading phrasing (through i18n), Markdown class
tweaks.

## Must stay green

The root (Duet) pseudo-agent path in `agents.tsx`; Train/onboarding surfaces
on the canvas; existing readme consumers if any remain.

## Feedback that would change this slice

Whether marketplace detail should show the fallback AGENTS.md for listings
whose derived description came from the fallback — it does (derive owns the
fallback), by design; if Example User dislikes prompt-prose on detail pages, the
fix is authoring DESCRIPTION.md (slice 09), not plumbing.
