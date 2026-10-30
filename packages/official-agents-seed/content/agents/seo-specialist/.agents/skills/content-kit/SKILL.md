---
name: content-kit
description: Derive a site's voice and design system from its own published pages and keep it current. Use before the first draft in a workspace, when seo/_kit/voice.md is missing or contradicts what the site now publishes, or when the user adds an inspiration URL.
---

# Content Kit

The kit is why the output sounds like the user instead of like every other AI blog. It is built **once per workspace**, from the user's own published pages, and `AGENTS.md` already declares that it wins over generic writing rules. This is how to build it and keep it honest.

## Detect first

The kit exists iff `seo/_kit/voice.md` is present. If it is, read it and go to work — do not rebuild it, and do not interview a user whose voice is already on disk. If it is absent, build it now, before any card reaches `brief`.

## Derive, don't interview

**Ingest mode is the default.** If the site publishes anything — a blog, guides, docs, changelog, even a dozen landing pages — the answers are already written. Map the site, read 8–12 representative pages, and derive the kit from what is actually there. Pull the palette and typefaces from a branding extract of the homepage. Then show the user the result and ask them to prune it. That is a confirmation, not a gate.

**Interview mode is the fallback**, for a site with nothing published. Two short rounds, batched, and every question optional except the site URL:

1. Who reads this, and what are they trying to do? Voice in three words. How heavily should the product appear — not at all, lightly, or one clear moment?
2. Tone dials 0–10 for formality, warmth, technical depth, energy, opinion. Brand colours and typefaces, or a URL to pull them from. Cover style, with an example if they have one.

Never block a card on an unanswered optional question. Default the tone dials to 5, the product moment to one mention, and say in `voice.md` which values were defaults rather than observations.

## What each file must contain

`seo/_kit/voice.md` — and every line of it must be falsifiable against a real page:

| Section | The bar |
| --- | --- |
| Voice pillars | 3–6, each one sentence, each with the page that demonstrates it. "Answer-first" with a URL beside it, not "clear and engaging" |
| Tone dials | Five values 0–10, as `casual **7** formal`, each derived from an observed page or marked `default` |
| Structural conventions | How this site actually opens, headers, lists, ends. Sentence and paragraph length it really uses |
| Signature moves | 2–4 things that make the writing recognisably theirs — a recurring device, a stance, a format |
| Do / Don't | Concrete. "Never a rhetorical question as an H2" beats "avoid fluff" |
| Product moment | Where the product appears, how long, how linked |

`seo/_kit/design.md` — palette with hex codes in backticks, display and body typefaces, cover concept and composition, brand-mark rule, inline diagram style, and the two sizes (cover 1200×630, inline 800×500).

`seo/_kit/sources.md` — inspiration URLs under **Pending** and **Digested**, each with what the user liked and whether it informs content, design or both.

A pillar you cannot attach to a real page is a guess. Write `inferred` beside it or drop it.

## Bounds

Map once. Scrape 8–12 pages for voice and one branding extract for design — this is a one-time cost, but it is not a crawl of the whole site. Prefer the most recent posts and the two or three that the site itself links to most; those are what the author is proudest of. Skip anything ghost-written, syndicated or obviously templated, and say in `voice.md` what you excluded.

## Inspirations are accents, never replacements

When the user adds a reference URL, read the pending entries in `sources.md`, scrape each once, and blend the signal into an **Inspiration blend** section at the bottom of `voice.md` or `design.md` — under the base voice, attributed to its source, never overwriting a pillar. Then move the source from Pending to Digested with one line saying exactly what was pulled, and show the user the diff.

The base voice is the user's own. If an inspiration would contradict a pillar derived from their real pages, the pillar stands and you tell the user about the conflict instead of resolving it silently.

## Staleness

The kit carries a version and a date. If the site has published new work since the last version and a draft is about to be written, spot-check two recent pages against the pillars. If they no longer match, say so and offer a re-derivation — do not quietly write to a voice the site has moved on from.

## Using it

`brief.md` shapes the title style, H2 framing and product-moment weight from `voice.md`. `draft.md` obeys its pillars, dials and do/don't list. `publish/` and any generated asset obeys `design.md`. When a kit rule and a generic SEO convention collide, the kit wins — and `review.md` records which rule beat which, so the human can overrule the kit rather than discover it.
