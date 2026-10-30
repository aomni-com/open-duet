---
name: signal-threshold
description: Decide whether a cluster of posts is a real theme or too small to report. Use when counting mentions, judging a spike, collapsing a quote cascade, or deciding whether a sample supports a claim about what "people are saying".
---

# Signal Threshold

`AGENTS.md` sets the bar — 5 distinct accounts over a rolling 7 days. This is how to
count so that the number means what it says.

## The unit is a distinct account, not a post

One account posting nine times is **1**. Count `user.id_str` on X and the actor URN on
LinkedIn, never the number of rows in the response. Keep the account ids in the theme
file; a count you cannot re-derive from ids is a number you made up.

## Collapse before you count

Walk every post to its root first, in this order:

1. `retweeted_status` present → the root is the retweeted post. The retweeter is an
   amplifier, not a source.
2. `quoted_status_id_str` present and the post adds no claim of its own ("this", "^",
   an emoji) → amplifier. If it adds a *distinct* claim, it is its own source and
   counts.
3. `in_reply_to_status_id_str` present → part of that thread. A reply agreeing with
   the root is an amplifier; a reply making its own complaint counts.
4. Same wording appearing across accounts within minutes → a copy or a screenshot
   cascade. One origin.

Then report both numbers, always paired: `<origins> origin(s), <posts> posts,
<amplifiers> distinct amplifiers`. Only origins cross the bar. Reach is a real and
useful metric — it is just never the answer to "how many people said this".

## The bands

| Distinct origins / 7d | What it is | Where it goes |
| --- | --- | --- |
| 1–2 | Individual posts | The sweep file. In the digest only if a named person is blocked, press, or a customer at risk |
| 3–4 | Watchlist | Watchlist table, with what would make it a theme |
| 5+ | Theme | Themes table |

The Watchlist row must name its own escape condition — "2 more accounts unconnected to
the original thread" — so the next sweep can settle it instead of re-arguing it.

## The spike test

Both conditions or it is not a spike:

- today's distinct origins ≥ 3× the trailing 14-day median for that query, **and**
- today's distinct origins ≥ 5.

With fewer than 14 sweeps in `sweeps/`, there is no median. Say "no baseline yet, N
sweeps of history" and report the raw count. A 3× rise from 1 to 3 is not a spike; it
is two more people.

## Say it when it is too small

The small-sample verdict is a required output, not a fallback:

> 3 accounts over 6 days is not enough to call this a theme.

Do not soften it into "early signal", "emerging", or "worth watching closely". Those
phrases are how a Watchlist row arrives in a roadmap meeting as a trend. "Worth
watching" is exactly what the Watchlist table already means, and the number carries it.

## Samples do not merge

X and LinkedIn are separate populations reached by separate queries; keep their counts
separate and never sum them into one theme count. The same applies across windows —
4 accounts this week plus 4 last week is two 4s, not an 8, unless the theme file shows
the accounts are distinct and the window you report is the full 14 days.

No sentiment percentage below 20 posts on one platform, and always print the
denominator: "62% negative (n=41 posts, 33 accounts)", never "mostly negative".
