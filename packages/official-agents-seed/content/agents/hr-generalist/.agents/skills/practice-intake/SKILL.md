---
name: practice-intake
description: Build and maintain practices.md — the confirmed record of how a company actually operates, that every handbook clause traces back to. Use before drafting any policy, when a practice is unclear or contested, or when the company changes.
---

# Practice Intake

`practices.md` is the table the handbook is *derived* from. `AGENTS.md` says every clause traces to a row; this is how a row earns its place.

## One row per practice

| Column | Rule |
| --- | --- |
| `practice` | One thing that happens. If it contains "and" or "usually", it is two rows |
| `applies to` | Locations and worker types from `scope.md`. Never "everyone" unless `scope.md` says there is only one group |
| `confirmed by` | A person and their role. Not "the team", not "the docs" |
| `date` | When they confirmed it — not when you asked |
| `how` | `stated` / `documented` / `observed` (see below) |
| `state` | `confirmed` / `contested` / `unconfirmed` |

`how` is the column that catches the common failure: a practice everybody describes the same way and nobody has ever actually done. If nothing was `documented` or `observed`, the row is still `confirmed` — but a policy built only on `stated` rows says so in its Sources table, and the first exception will find you.

- **stated** — somebody told you. The default, and the weakest.
- **documented** — an existing doc, offer letter, tool config or approval thread shows it. Cite the file or URL.
- **observed** — you can see it in the system that runs it: the PTO tracker, the expense tool, the calendar.

## Asking

One batch of at most ten questions per policy area, to the one owner of that area. Ask what happened last time, not what the policy is:

- "Who was the last person to take extended leave, and what did they do to arrange it?" beats "What's the leave policy?"
- "What's the largest expense anyone has submitted without asking first?" beats "What's the expense limit?"
- "Who said yes the last time somebody asked to work from another country?" beats "Can people work abroad?"

The past tense is doing the work. Present-tense questions get the answer people wish were true, which is exactly the handbook this agent refuses to write.

## When answers conflict

Two people describing the same practice differently is the most valuable thing intake produces — it usually means the practice is discretionary and has never been written down, which is the reason someone asked for a handbook.

Do not average them and do not pick the more senior one. Both go in as `contested` rows, and the policy is blocked on an `open-questions.md` entry that shows both answers side by side and asks the owner to decide which one becomes the rule. Writing the midpoint invents a practice nobody has.

## Unconfirmed is not a gap to fill

A `state: unconfirmed` row is a question, never a draft clause. It reaches the policy as `<TO DECIDE: ...>` and stays visible. The pressure to replace it with something reasonable is the whole failure mode: a template's number is not this company's number, and once it is in the handbook somebody will rely on it.

## Before drafting

Every sentence you are about to write appears as a row. If it does not, either get the row or write `<TO DECIDE>`. The policy cannot contain a practice the table does not.

## After a change

When the company changes — a new country, a first contractor, a new entity, a tool swap, a headcount threshold crossed — add the rows first, then ask which policies the new rows contradict. Rows added at the time of the change are cheap; reconstructing them a year later at the staleness sweep is not.
