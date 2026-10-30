---
name: battlecard-governor
description: Govern sourced competitive claims through admission, expiry, and battlecard updates. Use when creating or refreshing a battlecard, processing a competitor move, reviewing a sales claim, or deciding whether evidence is current enough to use.
---

# Battlecard Governor

The battlecard is a governed view of the claim ledger, not prose written from memory. `AGENTS.md` owns its files, thresholds, and output shape; this skill controls how claims enter, change, and leave it.

## Workflow

1. Atomize the comparison. Split compound language until each candidate claim can be proved or rejected independently.
2. Record evidence for both sides where the claim is comparative. Capture the exact URL opened, publisher, publication date, checked date, and source class.
3. Write `direct support`: the narrow fact the source actually establishes. Do not write the desired claim first and retrofit a nearby citation.
4. Classify the source `FIRST_PARTY`, `INDEPENDENT`, `CUSTOMER`, or `INTERNAL`. Vendor marketing supports only a statement about its own published offer; internal evidence supports only our side.
5. Assign `ADMITTED`, `UNVERIFIED`, `CONTESTED`, or `EXPIRED`, then set the expiry from the defaults in `AGENTS.md`.
6. Find every battlecard that uses the claim ID. Update its comparison, talk track, landmines, status, and review date together.
7. For a monitored event, record `OBSERVED` separately from `ANALYSIS`, apply the materiality thresholds, and update a card only when an admitted claim or field guidance changes.

The run is complete only when every customer-facing comparative sentence maps to an unexpired `ADMITTED` claim and every affected battlecard has a recalculated status.

## Claim record

```markdown
### C-### — <atomic claim>
- Applies to: <segment, plan, geography, version>
- Their evidence: <exact URL or none>
- Our evidence: <exact URL or none>
- Source class: FIRST_PARTY | INDEPENDENT | CUSTOMER | INTERNAL
- Direct support: <what the source establishes, no inference>
- Checked: <YYYY-MM-DD>
- Expires: <YYYY-MM-DD>
- Status: ADMITTED | UNVERIFIED | CONTESTED | EXPIRED
- Used in: <battlecard paths or none>
- Limits: <what must not be said>
```

## Verdicts

- `ADMITTED`: the sources directly support the narrow claim, identity and scope match, both sides are evidenced where required, and the expiry date is in the future.
- `UNVERIFIED`: evidence is missing, inaccessible, ambiguous, or proves only one side. Keep it out of talk tracks.
- `CONTESTED`: credible sources disagree after checking scope, version, and date. Show the disagreement; do not choose the convenient source.
- `EXPIRED`: the check is outside its validity window. Preserve the record, remove it from current guidance, and name the refresh needed.

Absence claims require affirmative evidence such as a current limitation statement or a reproducible, dated evaluation with recorded scope. Failure to find a feature is `UNVERIFIED`, never proof it does not exist.

## Update rule

A material event does not automatically justify a new comparison. Trace it through:

```text
observed event -> affected claim IDs -> deal implication -> battlecard section -> digest entry
```

If the chain stops before an affected claim or field action, record the event as `NO CARD CHANGE`. That keeps monitoring informative without turning every announcement into sales guidance.
