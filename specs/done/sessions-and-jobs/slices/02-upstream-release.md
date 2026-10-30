# 02 — Upstream closeout: `review`, then `release` 0.3.8

**Repo:** `~/dev/duet-agent`. **Conditional on slice 00-A red.** Green means no
release — see the branch table in the README.

## Contract unlocked

A published `@duetso/agent` 0.3.8 that Duet can pin.

## API seam

That repo's own skills, in order:

1. `.agents/skills/review/SKILL.md` — sequences refactor-clean, code-review, and
   write-docs. Resolve every finding or record why it was dismissed; nothing
   stays open.
2. `.agents/skills/release/SKILL.md` — bump `package.json` from 0.3.7 to
   **0.3.8**, commit `chore: release v0.3.8`, annotated tag `v0.3.8`, push
   `main` and the tag.

The release skill's step 4 says to run broader tests when the release includes
code changes. It does — run the full Docker suite.

## The publish is tag-triggered, not local

`.github/workflows/publish.yml` runs on the tag: install → `bun run build` →
`bun run lint` → `bun run test` → GitHub release → npm publish. So:

- A red CI run means 0.3.8 does not exist, no matter what the local gates said.
- **Do not bump Duet's pin until npm actually serves 0.3.8**
  (`npm view @duetso/agent version`). Slice 04 depends on this.

## What the human can run or see

`npm view @duetso/agent version` → `0.3.8`, and the GitHub release page.

## Verification gates

Everything `review` reports, the full Docker suite locally, then a green
publish workflow.

## Must stay green

All of `~/dev/duet-agent`.

## Fixed by this slice

The version number; that `review` runs before `release`; that the release is
conditional on 00-A's colour.

## Delegated to the implementer

Nothing.

## What feedback would change this slice

If CI fails on a case the local Docker run passed, fix forward in slice 01 and
re-tag — do not publish by hand around the workflow.
