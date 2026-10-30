# 09 — Author the 24 official DESCRIPTION.md files + the authoring bar

**Contract unlocked:** every official agent ships reviewed, user-facing
long-form copy, independent of its system prompt. Header art is explicitly
OUT of scope (designer supplies later; cards ride the gradient).

## API seam

Content only — no runtime change:
- `packages/official-agents-seed/content/agents/<slug>/DESCRIPTION.md` × 24.
- `AUTHORING.md` gains the description bar. It extends the official-agents
  rules (role not task, not the product, stands alone, must refuse
  something): the description addresses the buyer/user, not the model — what
  role it fills, what it needs from you, how the work proceeds, what you get,
  where it stops. Ordinary business language; no skill names, paths, or
  system-prompt vocabulary; claims traceable to AGENTS.md or a declared app.
  Shared skeleton (structural consistency, not fill-in-the-blanks):
  `# Name` / opening outcome paragraph / `## What it does` / `## How it
  works` / `## What you get` / `## Boundaries`.
- `seed.test.ts` extends the authoring contract: DESCRIPTION.md exists for
  every manifest agent; ≤ `MAX_LISTING_DESCRIPTION_BYTES`; H1 = display
  name; non-empty prose, no TODO/placeholder copy; differs from AGENTS.md;
  bundle stays under the 16MiB budget; `bun run codegen` drift test green.

Authoring order (cohorts, calibrate then replicate):
1. Calibration — deliberately varied roles: research-assistant,
   account-researcher, support-agent, product-manager, brand-designer,
   website-builder. Fold review feedback into the bar before continuing.
2. Go-to-market: community-manager, competitive-analyst,
   landing-page-builder, performance-marketer, sales-coach,
   sales-development-rep.
3. Content & evidence: data-analyst, editor, operations-analyst,
   people-researcher, seo-specialist, social-media-manager.
4. People & quality: code-reviewer, hr-generalist, recruiter,
   technical-writer, ux-researcher, vendor-manager.
Then read all 24 in roster order: adjacent listings must not make
indistinguishable promises; strip repeated boilerplate voice.

## Human-visible

The 24 files; a rendered read-through (the slice-08 playground fixture or
local detail pages) so review is reading, not file-opening.

## Verification

Seed package tests + codegen drift; the review flow above. Human review
checkpoint is **non-blocking**: open a rendered contact view for Example User
(preview-shots if shots, otherwise links), wait ~5 min, then proceed on the
bar, recording any editorial calls here.

## Delegated to implementer

The prose itself, within the bar; cohort-internal ordering.

## Must stay green

Every existing seed authoring assertion (summary paragraph rules, prompt-line
minimums, tag coverage, bundle bounds).

## Feedback that would change this slice

Example User's editorial voice notes from the calibration cohort — expected, that is
what the cohort exists for.
