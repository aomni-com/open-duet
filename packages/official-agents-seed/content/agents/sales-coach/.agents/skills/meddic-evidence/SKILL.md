---
name: meddic-evidence
description: Grade call evidence against MEDDIC without converting rep assertions or optimistic inference into buyer-confirmed qualification. Use when building or revising a deal debrief from a recording, transcript, or rep notes.
---

# MEDDIC Evidence

`AGENTS.md` owns the folder and deliverable. This skill owns the qualification test: what the call proves, who proved it, and what remains unknown.

## Build the ledger before the narrative

Create one row for each MEDDIC element in `evidence.md`:

| Column | Rule |
| --- | --- |
| `element` | Metrics / Economic Buyer / Decision Criteria / Decision Process / Identify Pain / Champion |
| `status` | Confirmed / Partial / Missing / Contradicted |
| `claim` | One qualification claim, not a general impression |
| `source` | Buyer / Rep assertion / Unknown |
| `evidence` | Short verbatim excerpt with speaker and `mm:ss` timestamp |
| `missing proof` | The specific fact or buyer statement needed to advance the status |

If a row needs two claims, split it into two evidence lines beneath the same element. Never compress conflicting statements into a smoother summary.

## Status test

Apply the first matching status:

1. **Contradicted** — buyer-side evidence directly conflicts with the claim or with another material statement. Preserve both excerpts.
2. **Missing** — no relevant buyer-side evidence exists. Rep assertions may be recorded, but the element remains Missing.
3. **Partial** — buyer-side evidence establishes part of the element, but a material detail required below is absent.
4. **Confirmed** — buyer-side evidence directly establishes the element and its required detail. No inference is needed to finish the claim.

Confirmation is claim-level, not call-level. One strong field does not raise another. Never create a total MEDDIC score; the six statuses show more truth than an invented percentage.

## What each element requires

### Metrics

Confirmed requires a quantified outcome or business impact in the buyer's words, with enough context to know what the number measures. A qualitative benefit, a vendor benchmark, or a number introduced only by the rep is Partial at best.

### Economic Buyer

Confirmed requires buyer-side identification of the person or role with final financial authority. Seniority, attendance, budget influence, and the rep's guess do not establish final authority.

### Decision Criteria

Confirmed requires buyer-stated criteria that will actually determine the choice. Product interest alone is Partial; separate technical, commercial, security, or operational criteria when the call does.

### Decision Process

Confirmed requires the buyer to describe how the decision will be made: material stages, participants or approvals, and timing. A target date without the path to it is Partial.

### Identify Pain

Confirmed requires the buyer to state the problem and a consequence that makes it worth solving. A feature request without business or operational consequence is Partial.

### Champion

Confirmed requires evidence that a person has influence, a personal stake in the outcome, and is taking or has agreed to take a concrete internal action. Enthusiasm, responsiveness, or agreeing to another meeting is not champion evidence.

## Speaker and timestamp discipline

- A diarization label is not automatically a buyer identity. Map it only when the call establishes the identity; otherwise preserve `Speaker 1` or `Unknown`.
- Use the timestamp at which the supporting statement begins. If the idea spans turns, cite each relevant turn.
- Correct obvious transcription spelling only in `transcript.md`; preserve `transcript.json` and note the correction in `source.md`.
- If audio is inaudible at the decisive moment, mark the claim Missing or Partial and name the transcript limit. Do not reconstruct it from context.

## Turn gaps into questions

For every Partial, Missing, or Contradicted element, write one neutral question that could settle it. Ask for the fact, not agreement with the rep's theory:

- Prefer: "Who gives final financial approval, and what do they need to see?"
- Reject: "Since your VP owns the budget, can we get their approval next week?"

Order questions by deal risk: Economic Buyer and Decision Process first when access or timing is unclear; Identify Pain and Metrics first when the business case itself is unclear. Put no more than five in the internal debrief and no more than three in the customer follow-up.

## Final honesty check

Before writing the bottom line, inspect every use of **confirmed**, **agreed**, **committed**, **budget**, **decision**, and **champion**. Each must point to buyer-side evidence in the ledger. Downgrade the wording or status when it cannot.
