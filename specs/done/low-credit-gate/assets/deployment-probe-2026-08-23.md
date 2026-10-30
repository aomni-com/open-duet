# Hard-cutover deployment probe — 2026-08-23

Captured at `2026-08-23T06:54:01Z` with read-only Convex snapshot exports. The probe streamed the
`users` table into aggregate counters and discarded the local archives after inspection. It printed
and retained no user rows, email addresses, balances, or Stripe identifiers.

| Environment | Users inspected | Rows with `lowCreditWarningAcknowledgedPeriodStart` | Configured auto-top-up thresholds below `$5` |
|---|---:|---:|---:|
| staging | 276 | 0 | 0 |
| production | 248 | 1 | 0 |

## Authorized cleanup result

The user authorized deletion. A bounded, temporary internal mutation built from the current
production-source branch inspected 249 production users and cleared the obsolete field from exactly
one. The function was then removed from the production deployment. Inline read-only queries after
removal returned:

| Environment | Users inspected | Remaining acknowledgement rows | Thresholds below `$5` |
|---|---:|---:|---:|
| staging | 276 | 0 | 0 |
| production | 249 | 0 | 0 |

Verdict: strict schema deletion is unblocked. The cleanup introduced no compatibility field,
migration rail, persistent operator function, or change to credits, subscriptions, and payment data.
