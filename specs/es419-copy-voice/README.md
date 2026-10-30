# es-419 copy voice pass — placeholder

_Placeholder spec (2026-07-23, out of per-tier-storage's closeout). Not
sliced; run [write-spec](../../.claude/skills/write-spec/SKILL.md) or just
do it in one pass when picked up — it is small._

## Problem

`apps/web/messages/es-419/app.json` speaks with two voices for the same
concept: the dominant loanword **"workspace"** (~33 uses, including all
strings added by per-tier-storage, which followed the majority) and two
older **"espacio de trabajo"** outliers. Mixed terms in one surface read as
sloppy localization.

## Decision needed (Example User)

Pick the canonical term — the loanword "workspace" (current majority, terser
in UI chrome) or "espacio de trabajo" (fully localized, longer). Everything
else follows mechanically.

## Scope

- Sweep `messages/es-419/app.json` (and any other es-419 catalogs) to the
  chosen term; check gendered articles/adjectives agree around it.
- Re-run the full web test suite — catalog parity tests and any copy pins.
- Out of scope: retranslating anything else; en catalogs; new keys.

## Verification

Grep proves a single term remains; web suite green; visual baselines only
re-approved where a string length change moves layout.
