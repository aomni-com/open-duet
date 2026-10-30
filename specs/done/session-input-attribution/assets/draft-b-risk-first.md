# Draft B — Risk First

Bias: isolate provenance, prompt injection, identity lifecycle, queue ordering, UI reconciliation, and deployment risks before integration.

The draft proposed seven slices: provenance/security, identity/envelope, durable/API cutover, delivery composition, history/UI, teaching, and a new staging journey.

Useful pressure retained in synthesis:

- Test every credential kind and prove app/system do not inherit their owner-shaped `actorId` as sender.
- Resolve source sessions authoritatively in the addressed workspace.
- Freeze exact XML bytes and adversarial escaping, including fake envelope and reminder tags.
- Test rename-before-drain, missing-user failure, deleted app fallback, mixed-sender notes, lease replay, image ordering, and sender-aware idempotency.
- Make visual author categories and accessibility observable in desktop and mobile fixtures.

Rejected during synthesis:

- A `system_vm`-only `sourceSessionId` exception contradicts canonical workspace security; no policy exception is created.
- Seven slices introduce partial internal states without seven distinct human checkpoints.
- Resolved names/emails do not belong on the history wire.
- `agentSessions.userId` ownership removal is a large unrelated redesign.
- A new staging journey duplicates the existing session lifecycle fixture and cleanup owner.
- Exact delivery bytes cannot be promised across a real identity rename; stability is asserted only for the same durable rows and same current identity state.
