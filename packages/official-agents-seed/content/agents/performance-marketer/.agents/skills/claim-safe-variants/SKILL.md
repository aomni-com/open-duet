---
name: claim-safe-variants
description: Admit advertising claims and build auditable creative variant sets. Use when turning an offer into ad copy, reviewing a benefit or statistic, designing a creative test matrix, or reading results into a next test.
---

# Claim-Safe Variants

The claims ledger is the admission gate and the variant matrix is the experiment contract. Build both before generation; a polished asset cannot repair unsupported copy or an untestable design.

## Workflow

1. Read the campaign brief and confirmed brand kit. If either is absent, stop at the missing artifact.
2. Extract each proposed factual assertion into its own claim record before drafting copy.
3. Test the record against the user-supplied source: identity, exact support, scope, timeframe, population, conditions, and qualifier.
4. Mark it `ADMITTED`, `NEEDS EVIDENCE`, or `REJECTED`. Only admitted safe wording may enter an ad.
5. Build three concepts from the admitted set, then select two. Give each concept one falsifiable audience hypothesis.
6. Create three hook variants per selected concept. In each row, name the one changed variable and hold the rest constant.
7. Map every factual clause in headline and body to claim IDs. Remove or rewrite every unmapped clause before generation.
8. After production, reconcile files against the matrix. Every approved row has an asset or an explicit blocked/failed status.
9. After results, compare only like-delivered rows, label insufficient evidence directional, and specify one next variable to test against the retained control.

The skill is complete only when every factual clause maps to an admitted record and every approved matrix row is accounted for.

## Claim record

```markdown
### CL-### — <short name>
- Proposed claim: <the assertion the ad wants to communicate>
- Supplied source: <file or user-supplied URL>
- Location: <page, section, table, timestamp, or line>
- Exact support: <short quote or faithful data transcription>
- Scope: <who/what, geography, period, sample, and conditions>
- Safe wording: <the strongest wording the evidence permits>
- Required qualifier: <placement-ready qualifier or none>
- Status: ADMITTED | NEEDS EVIDENCE | REJECTED
- Rejection/gap: <what is missing or why it cannot be used>
```

One record supports one assertion. Split “faster and cheaper” unless the source separately establishes both. A supplied source that merely repeats another party's unsupported claim does not substantiate it.

## Admission rules

- A feature may be stated as a feature. It becomes a benefit claim when the copy promises an effect; admit that effect separately.
- A statistic retains its denominator, population, period, and material conditions. Do not round into a stronger impression.
- A customer result stays attributed to that customer and carries the relevant conditions. It is not a typical result.
- A comparison names the compared alternative and uses like-for-like evidence. “Best”, “leading”, “faster”, and “more” are comparisons even when the competitor is omitted.
- A guarantee requires the supplied terms that make it true. If exceptions would negate the headline's ordinary reading, reject the headline.
- Testimonials and customer logos require supplied, attributable approval. Anonymous praise is not social proof.
- Scarcity and deadlines require a real supplied inventory or offer condition. A countdown is not creative decoration.
- Questions and metaphors still fail if their ordinary takeaway asserts an unsupported fact.

Invented social proof, urgency, numbers, guarantees, and comparisons are `REJECTED`, never placeholders and never `NEEDS EVIDENCE` copy that proceeds to production.

## Variant row

```markdown
| ID | Concept | Hypothesis | Changed variable | Headline | Body | CTA | Claim IDs | Format | Asset | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
```

The changed variable is one of `HOOK`, `VISUAL`, `FORMAT`, `CTA`, `AUDIENCE`, or `OFFER`. If a row changes more than one, split the test or state that it is a new concept and cannot explain causality against the control.

## Audit

Before production:

- Read each headline and body for its ordinary takeaway, not only its literal grammar.
- Annotate every factual clause with claim IDs.
- Confirm qualifiers remain readable in the intended format.
- Confirm all rows share the declared controls.
- Confirm the full set, not one favored row, is approved for generation.

After results:

- Verify comparable objective, audience, placements, attribution window, dates, and delivery.
- Calculate from supplied numerators and denominators; leave unavailable metrics blank.
- Separate **Observation** from **Interpretation**.
- Never promote a performance interpretation into `claims.md` without new user-supplied substantiation.
