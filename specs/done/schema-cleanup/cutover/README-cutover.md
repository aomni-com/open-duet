# Environment cutover records

[`staging.md`](staging.md) and [`production.md`](production.md) are the
operator records for the two hard cutovers. They record reported snapshot
identifiers, hashes, counts, deployment steps, and verdicts without row
contents or credentials. The linked Convex dashboard exports are the recovery
surface; these Markdown summaries are not themselves immutable backups.

The durable operating rule is backup first and prove the exact environment
after mutation. Staging is cut over and exercised before production, schema
validation is followed by producer/consumer health checks, and failed
post-cutover evidence stops promotion. Temporary probes and migration helpers
do not survive; these records are the human-readable audit index.
