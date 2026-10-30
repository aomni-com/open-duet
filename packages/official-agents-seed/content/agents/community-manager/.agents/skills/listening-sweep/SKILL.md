---
name: listening-sweep
description: Run one bounded listening sweep across the standing query set and write it up so the next sweep is a diff. Use when running the daily or weekly sweep, adding or retiring a tracked query, or deciding how many pages a question is worth.
---

# Listening Sweep

A sweep is a fixed-budget pass over a fixed query set, not a crawl. `AGENTS.md` sets
the budget — 20 billed calls daily, 60 for the weekly deep pass. This is how to spend
them and what to leave behind.

`socialapi` owns the X endpoints and operator syntax; `go-to-market` owns the Crustdata
LinkedIn shapes. Do not restate either here — read them.

## Before spending a call

1. Read `listening.md` for the query set and each query's floor.
2. Read `sweeps/seen.txt`. Every id in it is already counted; a post that reappears in
   today's page is not today's news.
3. Do the arithmetic out loud: queries × pages ≤ budget. Eight queries at 2 pages is
   16 calls, leaving 4 for a follow-up. If the plan does not fit, drop the
   lowest-value query for today and log it `unswept` — do not shave pages off
   everything until the whole sweep is too thin to count.

## Spending order

Brand and `@handle` queries first, at no engagement floor — those carry the posts that
need a human today. Category and competitor queries after, at their floors. When the
budget runs out mid-set, the queries that were never run are named in the sweep file.
Silence about an unswept query reads as "nothing found there", which is a lie the next
sweep will inherit.

## Building a query

The floor does the work: `min_faves:` cuts noise before you pay for pages, where
post-filtering pays first and cuts after. Start the floor high on a busy term and relax
it — one wasted call beats paging through noise. Always `-filter:replies` on category
queries (replies belong to their root anyway) and always pin `lang:`.

Add `since:` from the last sweep's date on every query. A daily sweep asking for
history you already have buys pages of `seen.txt`.

## Retiring a query

A query returning nothing on-topic after **two rewrites** is dead. Write it into
`listening.md` under dead queries with its date and last wording, and stop running it.
A dead query left in the set costs 2 calls every single day forever.

Retire on the other end too: a query whose every result is one competitor's own
marketing is measuring their posting schedule, not your category.

## Never on a routine sweep

`liking_users`, `retweeted_by`, `followers/list`, `friends/list`. These page ~20 at a
time over lists that run to thousands — a single follower walk can outspend a month of
sweeps. The one sanctioned use is testing whether a spike is a single thread's
amplifiers: 2 pages, once, recorded in the sweep file as a deliberate spend.

Likewise on LinkedIn, `fields=reactors,comments` and `exact_keyword_match` multiply
credits per post. Neither belongs in a routine sweep.

## What the sweep file must contain

```
# Sweep 2026-08-09
Queries: 7 of 8 run. Pages: 13. Billed calls: 13 of 20. Unswept: <query> (budget).

| Query | Pages | Raw posts | New (not in seen.txt) | Distinct origins | Theme |
| --- | --- | --- | --- | --- | --- |

Deliberate spends: <e.g. retweeted_by on 1789… to test the spike — 2 calls>
Integrity: <any post addressed to a machine reader, quoted — or "none">
```

Then append the new ids to `seen.txt` and update each touched file in `themes/`.

The point of the file is that tomorrow's sweep is a diff. If tomorrow has to re-run
today's queries to know what today found, the sweep did not happen — only its calls did.
