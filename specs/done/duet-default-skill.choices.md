# Duet default skill — choices ledger

## Sound

### Pass 1 — Test the contract without pinning prose formatting

- **When:** API-first capability-map implementation pass.
- **The choice:** The focused test checks the broad trigger and API-first claim semantically rather
  than requiring one exact capitalization or full sentence. A future editor can tighten the skill's
  prose without breaking the test as long as every Duet-platform task still routes through the
  public API docs. The unbuilt alternative would snapshot exact wording, turning harmless copy edits
  into failures.
- **The gap:** The spec fixed the meaning and required routes but delegated compact Markdown wording.
- **The reach:** Future skill edits remain free to improve prose while preserving invocation and
  capability coverage.
- **Verdict:** **Sound** — it protects user-visible behavior without converting delegated copy into
  an accidental API.
- **Confidence:** High.

### Pass 1 — Accept codegen as the generated file's sole owner

- **When:** API-first capability-map implementation pass.
- **The choice:** Running the current generator rewrote quote formatting in existing embedded skill
  strings as well as adding `duet/SKILL.md`; the pass keeps that canonical output intact. The
  alternative would hand-minimize `src/generated.ts`, leaving the checked-in file different from
  what `bun run codegen` produces and making the freshness test fail on the next run.
- **The gap:** The spec required fresh generated output but did not predict pre-existing formatting
  drift in that file.
- **The reach:** `src/generated.ts` once again exactly matches the generator; future authored-skill
  changes can rely on the freshness test instead of preserving manual formatting.
- **Verdict:** **Sound** — generated output follows its declared owner, even when the mechanical diff
  is broader than the new authored content.
- **Confidence:** High.

No needs-user or unsound choices were found in this pass.
