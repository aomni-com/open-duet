# Strict source choices

The canonical writer deploys before schema tightening. Existing rows cannot pass
a strict schema until the resumable migration removes their former fields. The
temporary argument bridge accommodates the API still serving between backend
push and API promotion; both phases write only one runtime identity. The
required old fleet tally shape aliases the same runtime tally, and the new
API strips it; schema tightening removes that projection too. A permanent
fallback reader or parallel persisted identity would preserve the complexity this
change removes.

Migration preserves a runtime identity already written by a new observation,
rather than overwriting it with the former gateway column. The transaction sees
the current row, making retry and concurrent new observations safe without an
extra migration flag or journal.

Registration fallback retains a committed token without applying an incomplete
desired snapshot. Treating its missing machine set as empty could disconnect
valid mirrors after a transient projection failure. Regular sync remains the
one authoritative desired-state owner and repairs the projection on its next poll.

Historical audit provenance keeps the version labels that described its original
event. Those facts are distinct from live workspace diagnostics; rewriting them
or expanding this migration across the audit history would change unrelated data.

The frozen runtime's artifact paths remain the ordinary transport. Renaming them
would require a compatibility endpoint solely to get the held runtime to its
first strict update. Retaining the canonical URLs costs no extra endpoint or owner.

Credential demand is a read; accepted app roster reconciliation owns pruning.
The supervisor starts without a roster, so its empty map cannot retire saved App
keys. Splitting those two operations in the existing credential store preserves
startup state without a new readiness flag, persisted roster or auth owner.
