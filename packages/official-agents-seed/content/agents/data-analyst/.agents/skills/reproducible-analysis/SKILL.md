---
name: reproducible-analysis
description: Profile a dataset and validate a result before reporting it. Use when data first arrives, when a join or filter changes the row count, or when a finding looks surprising enough to be a bug.
---

# Reproducible Analysis

`AGENTS.md` owns where files live and what a finding looks like. This is the part that catches wrong answers before they get quoted: profiling on arrival, and validating anything surprising.

## Profile before analysing

Write these into `decisions.md` the first time a dataset is touched. Most wrong answers are visible here and nowhere later.

- **Row count**, and the grain in one sentence: "one row per *what*". If you cannot finish that sentence, stop — every downstream number will be wrong in a way that looks plausible.
- **Per column**: type, null count, distinct count.
- **Distinct count equal to row count** on a column you expected to repeat, or far below it on a column you expected to be unique — either is a grain you did not expect.
- **Ranges** on every date and numeric column. Dates in the future, negative durations, and values pinned at exactly 0 or 999 are sentinel values wearing a real type.
- **Duplicates** on the natural key. Report the count; do not drop them yet.

## Joins are guilty until proven innocent

Record the row count before and after every join. Then account for the difference:

- **More rows** — the right side was not unique on the key. You have fanned out, and every aggregate after this point is inflated.
- **Fewer rows** — the join dropped non-matches. That is a filter you did not say you were applying. Count what fell out and check whether it is a population you care about.
- **Same count** — still check that a key column did not go null.

An unexplained row-count change is a bug in the analysis, not a property of the data.

## Validate a surprising result

A result that contradicts expectation is a bug more often than a finding. Before reporting it:

1. **Reconcile a total against the source.** One number you can check by hand, end to end.
2. **Segment it.** If an effect is real it usually survives cutting by time or category. If it vanishes into one segment, name that segment — it is the actual finding.
3. **Recompute the other way.** A different route to the same number catches a wrong filter; the same wrong filter twice does not.
4. **Check the denominator.** A rate that moved because its base changed is not a change in the numerator.

If it survives all four, report it *with* the fact that you checked — that is what makes it credible.

## When the data cannot answer

Say which field or which population would be needed, specifically enough to go and get it. "Insufficient data" is not actionable; "no per-user timestamps, so retention cannot be computed" is.
