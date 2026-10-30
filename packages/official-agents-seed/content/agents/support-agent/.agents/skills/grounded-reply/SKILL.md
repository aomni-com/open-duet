---
name: grounded-reply
description: Build and maintain the source ledger a support reply is grounded in, and decide whether a source actually answers the ticket. Use when drafting a reply, when a source is close but not exact, when two sources disagree, or when deciding whether a question is answerable at all.
---

# Grounded Reply

`sources.md` is not a reading list. It is the set of things you are permitted to say, and a reply is assembled *from* it rather than written and then footnoted. `AGENTS.md` says where it lives and what the ticket card looks like; this is how to keep it honest.

## One row per fact

| Column | Rule |
| --- | --- |
| `id` | `s-001` upward. This is what a citation points at, so it never changes meaning — a rewritten source gets a new id. |
| `fact` | One assertion, in the words a customer would need. If it contains "and", it is two rows. |
| `where` | The URL you opened, the file path, or the resolved ticket id. Not a homepage, not a search result, not "the docs". |
| `verified` | The date you last read the source itself. Not the date the source was published, and not the date you first added the row. |
| `volatile` | `yes` for prices, quotas, limits, plan entitlements, setting names and URLs. `no` for concepts and procedures. Drives the staleness rule. |

A resolved ticket is a legitimate source and often the best one, because it is the answer a human already gave. Cite it by ticket id and record what was resolved, never the customer it was resolved for.

## The coverage test

Before writing a sentence, answer: **does this row state the customer's case, or is it merely about the topic?** This is where invented answers come from — a source that covers the neighbouring situation reads like an answer while you are holding the ticket.

Three failures worth naming, because each one feels like coverage:

1. **Different plan, tier or region.** A limit documented for one plan says nothing about another. If the ticket does not say which the customer is on, the verdict is `NEEDS-INFO`, not a best guess.
2. **Different version or surface.** A settings path in the web app is not the settings path in the mobile app or the API.
3. **The general case, asked about the specific one.** "Exports are supported" does not answer "can I export 400,000 rows".

If you cannot quote the row's `fact` into the reply almost unchanged, it does not cover the ticket. Escalate as `unknown-fact` and write the question into `gaps.md`.

## When sources disagree

Two sources giving different answers is not a judgment call — it is a documentation defect, and the customer is not the place to resolve it.

Check first, in order: are they about the same plan and surface; is one simply older (compare `verified`, and re-read the newer source rather than trusting the row); do they share an origin, so one is a copy of the other rather than a second opinion.

If a real conflict survives all three, escalate as `unknown-fact` with both ids, and mark both rows `contested`. A contested row cannot ground an `ANSWER` until a human retires one of them. Never average, never pick the more recent one silently, and never pick the one that makes the reply easier to write.

## Growing the ledger

The ledger is the compounding asset here — the second pass is cheaper than the first only if answers came back into it.

- When a human answers an escalation, add the answer as a row the same day, `where` pointing at the escalation. That is what turns one human answer into every future reply.
- When you re-read a source and it still says the same thing, update `verified`. Re-verification is cheap; a stale row that quietly grounds a price quote is not.
- When a source turns out to be wrong, delete the row and add a `gaps.md` entry. Leaving it with a caveat means someone cites it later.

## Before the card is written

Every factual sentence in the draft appears in the Citations table with a row id. If one does not, either find the row or delete the sentence. The reply cannot contain a claim the ledger does not — and a deleted sentence usually becomes the "Not known" line, which is the useful half of the ticket.
