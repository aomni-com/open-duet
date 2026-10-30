---
name: creative-rounds
description: Run one round of creative iteration — declare the single variable, generate with the logo area clear, composite the real mark, check the render against the copy, and record the verdict. Use whenever an asset is being made, revised, or exported for approval.
---

# Creative Rounds

Iteration is the job. `AGENTS.md` owns the folders, the surface defaults, and the round record's shape; this skill owns what happens inside one round and what has to be true before a file reaches the user.

The discipline that makes rounds work is boring: one variable, everything else held, every version kept. Without it the fourth round is worse than the second and nobody can prove it, because the second no longer exists.

## The round

1. **Declare the variable.** Write down the single thing this round changes and the things it holds. If the user asked for three changes at once, do the one that decides the others first and say why the rest are waiting a round.
2. **Write the prompt against the kit, not against taste.** Name the colours by hex, the imagery direction, and the composition. State the copy exactly as approved, in quotation marks. Reserve the logo area explicitly — *"leave the lower-left corner empty, no logo, no text"* — because a model asked for a brand graphic will invent a mark unless told not to.
3. **Generate within the cap.** Three renders per direction, eight per round. Each successful generation is billed, so a re-roll needs a reason you could say out loud; if two re-rolls have not fixed it, the prompt is wrong or the thing belongs in the composite.
4. **Composite the real mark.** Place the file from `brand/assets/` into the reserved area at the kit's clear space and minimum width. Keep the script that did it beside the output, so round five can place the mark identically to round one.
5. **Set type in the composite when the render keeps mangling it.** A background generated clean plus real type is always correct; a headline generated into pixels is correct most of the time. Switch after the second failure, not the fifth.
6. **Run the render check.** Below. It gates delivery.
7. **Record and present.** Append the round to `rounds.md`, then show the directions with the bet each one makes and your recommendation.

## The render check

Open every file and look at it. This is not a review of the prompt; it is a reading of the pixels, and it is the step that catches what generation gets wrong.

- **Read the text back, character for character,** against the approved copy. Dropped letters, doubled words, mangled ligatures, and a plausible sub-headline nobody wrote are all common and all invisible unless read.
- **Confirm the mark is the composite,** not something the model drew. Look at the letterforms and the spacing, not the silhouette. Any second mark anywhere in the frame is a failure.
- **Check the safe area** for the surface: nothing that must be read sits where a platform crops, overlays a caption, or rounds a corner.
- **Check legibility at real size,** not at full resolution. A headline that works on a monitor can vanish on a phone; view it at the size the surface actually renders.
- **Check contrast** against the value the kit requires, computed rather than eyeballed, including where type has landed on a busy part of an image.
- **Look for artefacts** — extra fingers, warped product, nonsense in the background, a watermark, text in a language nobody asked for.
- **Check the file itself:** dimensions match the surface, the format is right, and it is not a re-encode of an earlier lossy export.

Record `PASS` or `FAIL — <what was wrong>` per file in the round record. A `FAIL` does not go to the user with a caveat: fix it, or report the direction as blocked and say what would unblock it.

## Verdicts

- **picked** — the user chose it. It becomes the base the next round holds constant.
- **rejected — <reason>** — write the reason in terms of the asset, not the render. "The claim reads as the headline and the product disappears" is reusable; "didn't look right" is not.
- **blocked** — something outside the round stops it: a missing logo file, a claim with no source, a font that is not licensed. Name the file or the fact needed.
- **approved** — the user approved this exact file. Only then does the export set get produced.

## After approval

Approval is of one file, and it expires the moment anything changes.

1. Export every surface in the brief from the approved master, never from an export.
2. Run the render check again on each export — a resize is a new chance to lose legibility, and a recrop is a new chance to lose the safe area.
3. Write `approved.md`: version, date, approver, where the asset may and may not be used, the source files it composited, every claim in the copy with the source the user supplied, and what breaks if it is resized or placed on a dark background.
4. Any later edit — a word, a crop, a colour — is a new round with its own approval. Do not patch an approved file in place.

## Returning to an earlier round

Rounds accumulate and are never overwritten, so "the second one was better" is a real instruction rather than a request to guess. Reopen that round's folder, state which version is now the base, and start the next round from it. Say in the record that the branch happened, so the log still explains how the approved file came to exist.
