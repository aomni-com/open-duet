---
name: legal-review-queue
description: Decide whether a handbook claim needs a lawyer, mark it in place, and track it to resolution. Use when drafting a policy that touches leave, pay, hours, classification, termination, or monitoring, or when someone asks what the law requires.
---

# Legal Review Queue

`AGENTS.md` says the rule: write what the company does, never what the law requires, and mark the difference. This is how to tell which sentences are which, and how a marker gets closed.

## The test

A sentence needs review if it is true or false **because of where somebody works**, rather than because of what the company decided.

- "You get 20 days of paid vacation." — a company decision. Ships.
- "You get 20 days, the statutory minimum." — true only in some places. Marked.
- "Unused days expire on 31 December." — a company decision, but carryover is regulated in many places. Marked.

The second clause is the tell: a practice becomes a legal claim the moment you explain, justify, or bound it by law. When in doubt, split the sentence — keep the practice, mark the justification.

## What always needs review

Any clause touching: statutory minimums or maximums of any kind; worker classification (employee / contractor, exempt / non-exempt); notice and termination — grounds, process, severance, final-pay timing; leave with a statutory floor (sick, parental, medical, jury, military, bereavement); working time — hours caps, rest breaks, on-call and travel compensability; pay — minimum wage, overtime rates, deductions, pay frequency, pay-transparency disclosure; restrictive covenants — non-compete, non-solicit, IP assignment; protected characteristics, accommodations, and complaint handling; monitoring, surveillance, and employee-record retention; right to work and immigration; health and safety obligations.

Plus any sentence containing **"required by law", "legally", "statutory", "must", "entitled to", "we are obliged"** — those words are the request for review, whatever the topic.

## Marking

Inline, at the sentence, in the policy file:

```
[LEGAL REVIEW — <jurisdiction>] <the exact claim in question>
```

The jurisdiction comes from `scope.md`. **One marker per jurisdiction** — a claim about staff in three countries is three markers, because one reviewer's yes does not answer for the others. A single unqualified marker is how a US answer silently becomes UK policy.

Then a row in `handbook/legal-review.md`:

| Column | Rule |
| --- | --- |
| `id` | `lr-001` upward |
| `claim` | The sentence, verbatim |
| `jurisdiction` | One. Never a list |
| `where` | `policies/<slug>.md`, section |
| `with` | The named person it is waiting on. Not "legal" |
| `raised` | Date |
| `state` | `open` / `resolved` / `withdrawn` |

## Resolving

Only a named person closes a marker, and only in writing. The row records who, the date, and **their words** — not your paraphrase of them, and not the marked claim with the marker deleted. If their answer changes the clause, the clause is replaced with what they wrote and the policy takes a new version.

If nobody answers, it stays open. An old marker is not a stale one that can be dropped; it is a policy that is still not ready to publish. Escalate it into `open-questions.md` addressed to the person who can appoint a reviewer.

`withdrawn` exists for one case: the clause was deleted. A claim is never withdrawn because it turned out to be obvious.

## What you never do

Do not answer the question yourself while waiting. Do not soften a claim into a hedge — "generally", "typically", "in most jurisdictions" is the same claim with deniability attached, and it reads as advice to the employee holding it. Do not resolve a marker with a link to a government page or a scraped statute; a reviewer's judgment about this company's facts is the only thing that closes a row.
