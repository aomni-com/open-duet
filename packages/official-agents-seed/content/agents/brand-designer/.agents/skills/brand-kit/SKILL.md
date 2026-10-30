---
name: brand-kit
description: Establish, record, and enforce a brand's visual system before any asset is generated. Use when starting with a new brand, when a kit is missing or thin, when a creative has to be checked against the system, or when a round teaches something the kit should carry.
---

# Brand Kit

The system is the thing that makes the tenth asset look like the first. `AGENTS.md` owns the folders and the defaults; this skill owns how a kit is built, what makes it complete enough to generate against, and how an asset is checked back against it.

A kit is not a palette. It is a set of decisions about **roles** — what the dark colour is *for*, which lockup goes on a photograph, how small the mark may get — because a hex code without a role gets used as a background by the next person who reads it.

## Building one

1. **Take what exists before asking for it.** Pull the brand's own site: colours, fonts, logo, imagery, and the way it talks. Most of the system is already published; a questionnaire the user has to fill in first is how this stalls.
2. **Collect the real files.** Extraction gives you a logo *URL* and a font *name*, neither of which is usable. Ask for the logo lockups as files, the licensed font files or the confirmed web font, and any product photography, and put them in `brand/assets/`.
3. **Assign roles, not names.** Every colour gets a job: surface, ink, accent, and the one used for a state or a warning. A brand with five blues has one accent and four decisions nobody has made.
4. **Fix the type scale.** One display family and one text family at most, with three sizes and two weights. Record the fallback for each, because a licensed font is not present everywhere the asset will be opened.
5. **Write the logo rules down.** Which lockup on light, which on dark, which on a photograph; clear space; minimum size; and the exclusions — recolouring, stretching, adding effects, placing it on a busy image, redrawing it.
6. **Confirm the kit with the user before generating.** Present it as decisions in their words — "your accent is the orange, and it's for buttons and highlights, never a background" — and change what they correct. Then it is theirs, and every later disagreement is about an asset rather than about the system.

## What makes it complete

A kit is ready to generate against when all of these are true. Until then, say which line is missing and stop before generating:

- Colour roles are assigned and each carries a hex value.
- A type family and scale are recorded, with a fallback.
- At least one logo lockup exists **as a file** in `brand/assets/`, with clear space and minimum size.
- The exclusions are written — what must never happen to the mark.
- Imagery direction says something an image prompt can act on: photographic or illustrated, warm or cool, people or product, and what is off-limits.
- Voice is captured well enough to write a headline: how long a sentence runs, whether it makes claims or asks questions, and words the brand does not use.

A brand described only as "clean and modern" is not a kit. Taste words are the user's starting point, not the system's — turn each one into a decision and show it back.

## The file

`brand/brand-kit.md` follows this shape:

```markdown
# <Brand> — brand kit
**Established:** <YYYY-MM-DD>  **Confirmed by:** <who>  **Sources:** <site URLs, files>

## Colour
| Role | Hex | Used for | Never |
| --- | --- | --- | --- |

## Type
| Role | Family | Weight | Size | Fallback |

## Logo
| Lockup | File | Use on | Minimum width | Clear space |

**Never:** <recolour, stretch, add a shadow, redraw, place over a busy image, …>

## Imagery
<what a picture of this brand looks like, in terms a prompt can use — and what it never is>

## Voice
<sentence length, register, what it claims, words it does not use>

## Learned
| Date | What an asset taught | What changed here |
```

## Checking an asset against it

Before a creative goes to the user, walk the kit and answer each line for the file in front of you:

- Are the colours the kit's roles, in their roles — accent as accent, not as a background?
- Is the type the kit's family and scale, and does it survive at the size it will actually be seen?
- Is the mark a composite of the file in `brand/assets/`, in its clear space, above its minimum width, on a background its lockup is for?
- Does the imagery match the direction, and does it avoid the off-limits list?
- Does the copy sound like the voice section, and does every claim in it have a source the user supplied?

A "no" on any line is a failed check with a named line, not a note in the delivery message.

## Keep the kit fed

A round that discovers something — a colour pair that vanishes over photography, a headline length that survives being cropped on a phone, a lockup that is unreadable at story size — writes it into `Learned` and, if it is a rule now, into the section it belongs to. A system that never changes after the first day is one that gets quietly abandoned instead.
