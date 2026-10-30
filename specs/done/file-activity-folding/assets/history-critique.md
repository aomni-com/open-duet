# Unprimed critique of the history pane — 2026-08-16

Run during slice 02 on `files-history-paginated` (desktop, mobile, and a 3×
crop). The agent had no project context and was not told what changed.

## Acted on in slice 02

| # | Finding | What changed |
|---|---|---|
| 3 | *"Edited 103 files" in a single-file history is either a bug or a rollup that never says what it did to THIS file.* | Correct, and the fixture was unreal: a server fold sits on the **folder** entity, so it can never appear in a file's history. Moved to the folder-scoped feed, where production actually puts it. |
| 4 | *"Two adjacent rows, same verb, two different structural patterns for a quantity."* | `Edited … / 6 saves` (sub-text) vs `Edited 103 files by …` (inline). Collapsed to one shape: the verb never carries a number, and every magnitude renders as sub-text. |

## Pre-existing — recorded, deliberately not fixed here

These are real and predate this feature. Fixing them inside a folding slice
would have hidden unrelated copy changes in a behaviour diff.

| # | Finding | Confidence |
|---|---|---|
| 1 | *"Seen during this period"* has no defined period on screen, carries no count or range, and is the only subject-first row — reads as a sentence fragment | high |
| 2 | The two "seen" rows contribute nothing to the bold verb scan; their only text is light grey, so the rows a reader most wants to skim fight the scan hardest | high |
| 5 | *"Restored from a snapshot [chip]"* drops the grey "by" every other row has, so it briefly parses as "a snapshot **of** Maya Chen"; it also never says which snapshot | high |
| 7 | Four consecutive "1d ago" stamps with no tie-breaker, and a mixed unit ladder (1d/20h) where 20h and 1d differ by four hours but read as different scales | medium |
| 8 | List is oldest-first, so "Load more" at the bottom implies loading *newer* rows; the full-width bordered button also reads as an eighth history row | medium |
| 9 | Human and agent chip glyphs share size, weight and silhouette, so the person/AI distinction rests entirely on the word "Agent ·"; the person glyph reads as a tofu box | medium |
| 10 | Three chip grammars (`API key · Name`, `Agent · Name`, bare `Name`); "human, direct" is signalled by *absence* of a prefix, the weakest possible signal | medium |
| 11 | Timestamps are left-aligned in their column, so the gutter to the content column varies row to row | medium/low |
| 12 | Mobile is a squeeze, not a reflow: the longest rows end ~35px from the padding with no visible wrap or truncation strategy | medium |
| 13 | Three or four grey levels are in play, and the weakest carries whole-sentence meaning rather than decoration | medium/low |
| 14 | The drawer sits flush to the viewport edge and overlays the toolbar's "Saved" status with no gutter or shadow | low |

**Worth a follow-up of its own:** findings 1, 2, 5 and 9 are all the same
shape — the read/restore rows and the actor chips never got the care the change
rows did. That is a copy-and-affordance pass on the history pane, not part of
folding.
