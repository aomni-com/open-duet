# 10 — Web: lineage chip, attributed bubble, default entry points

**Repo:** Duet, `apps/web`. Visual slice. Depends on slices 08 and 09.

## Contract unlocked

The user can see that a session was started by another session, can tell an
injected message from their own, and reaches an agent's default conversation by
clicking the agent.

## Three surfaces, one visual variable each

1. **Lineage chip in the session header** — "started by Ops — main", linking to
   the parent. D19 chose the header; the Jobs-list "Started by" column was
   explicitly declined, so do not add it.
   *Judged on:* the header row only. Out of scope: the transcript, the composer,
   the Jobs table.
2. **Attributed message bubble** — a `user_prompt` with `origin` other than
   `user` renders as attributed, not as the viewer's own message.
   *Judged on:* one bubble, cropped to the message row. Out of scope: transcript
   density, avatars elsewhere.
3. **Default-session entry point** — clicking an agent card opens its default
   conversation via the alias route; the roster rail's pinned Duet card
   (`apps/web/spa/drive/agent-roster-projection.ts:34-46`) gets the same
   treatment for root.
   *Judged on:* the click target and the resulting route. Out of scope: card
   layout, session-list styling.

The job transcript itself gets **no special UI** — D-extracted taste: it reads as
an ordinary conversation with the identical UI. Do not build a job-specific view.

## What the human can run or see

The playground fixtures for the session header and roster rail, plus the running
app.

## Verification gates

- [ui-playground](../../../.claude/skills/ui-playground/SKILL.md) for the visual
  regression gate on changed TSX.
- **[screenshot-critique](../../../.claude/skills/screenshot-critique/SKILL.md)
  is a required last check** on every shot this slice produces, before the slice
  is accepted. Unprimed second opinion; the regression gate and your own
  inspection do not substitute.
- **[compare-screenshots](../../../.claude/skills/compare-screenshots/SKILL.md)**
  for the header and bubble, which both change a prior look — judge
  candidate-against-prior, not candidate-against-nothing.
- `bun run build` for `apps/web` (the Next build is not in the local gates).

## Human review checkpoint — non-blocking

Open the shots with
[preview-shots](../../../.claude/skills/preview-shots/SKILL.md), allow ~5
minutes for a reaction, then decide on the evidence, record the decision and
rationale in this spec, close the shots, and proceed. Do not stall the build
waiting for sign-off.

## Must stay green

Existing session-view snapshots; the roster rail's pinned-card visual gate
(`agent-roster-rail.tsx:55` names it a settled visual variable); mobile shell
shots, which are shell-clipped by design — pin content with DOM asserts.

## Fixed by this slice

Header-only lineage. Attributed bubbles for non-`user` origin. No job-specific
transcript UI.

## Delegated to the implementer

Chip wording and placement within the header row; the attributed bubble's exact
treatment; the "(deleted parent)" state's copy.
