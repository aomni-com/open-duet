# Session payload and rendering performance

Human-facing session history is a compact projection of the agent's work.
The VM retains complete working data and recovery checkpoints; stored diagnostic
previews make delivery and browser rendering affordable as sessions grow.
This closes P44–P48 from the [performance ledger](../../performance-hardening/README.md).

## Boundaries that matter

Diagnostic payloads have a 1 KiB encoded-JSON allowance per field, including
truncation markers. Input, details, and combined output have separate allowances
so a large argument cannot erase the useful result. Identity, status, ordering,
and machine definitions retain their meaning. Expanded tools show the stored
preview; there is no second client trim or full-output endpoint. Existing
Convex history is not migrated.

The publication boundary must cover every copy of a diagnostic value. Testing
found stdout copied into relay history and completion state, and a separate live
patch path before ledger publication. Trimming only task chunks would still
leave a large-output failure. Normalization covers these human-facing copies;
the original event still reaches the local recovery checkpoint.

A row limit cannot bound a database transaction when historical rows vary in
size. Live replay therefore shares history's read/response byte budgets while
retaining its numeric delivered-sequence cursor. Large historical rows produce
shorter pages without changing order or reconnect semantics.

The browser cache owns the distinction between an ordered append and replaced
history. Its local generation lets projection process new durable events without
rescanning the prefix merely to prove it unchanged. Full replay remains the
fallback for historical reconciliation. Immutable array copies still happen;
this does not claim zero-copy appends. Closed native tool disclosures do not
mount their payload bodies; opening formats the latest stored preview.

## Code and verification

- Publication and checkpoint separation: `storableEvent` and coordinator event
  handling in `packages/gateway/src/agent-sessions/`; serializer, ledger and
  coordinator-envelope tests pin bounded publication with complete local data.
- Historical replay: `readEventPage` in
  `packages/backend/convex/domains/agentSessions/queries.ts`; real API tests in
  `apps/api/src/sessions.test.ts` reproduce database read overflow, then verify
  ordered delivery and cancellation/resumption with large valid events.
- Browser append semantics: `apps/web/spa/sessions/session-data.ts`,
  `session-cache.ts`, and `projection/index.ts`; `session-data.test.ts` and
  `projection/index.test.ts` compare incremental results against full replay
  and count event visits.
- Disclosure rendering: `apps/web/spa/sessions/ordered-agent-parts.tsx`; its unit
  tests count serialization and Docker browser tests exercise keyboard toggling.
- Live acceptance: `packages/test-harness/src/staging-e2e-synthetic`
  extends `relay-recovery` with a real 350 KiB script output and terminal delivery.

The integrated root gate passed all 23 tasks, including visual coverage and
asset checks. The expanded `relay-recovery` staging journey passed against revision
`46be4f969788a0d6c1c2e8fd9cb1be8868d06ed0`, including oversized output and
active-turn reboot recovery. Run `staging-e2e-synthetic`
reported all resources deleted and zero orphans.

## Visual provenance

The visual requirement is unchanged native disclosure appearance and behavior.
The comparison standard is the existing desktop/mobile `session-ordered-parts`
Docker baselines in `apps/web/tests/visual/__screenshots__`. The captures here are
production-owner Docker results: [desktop closed](assets/desktop-collapsed.png),
[expanded](assets/desktop-expanded.png), [image](assets/desktop-image.png), and
[mobile closed](assets/mobile-collapsed.png),
[expanded](assets/mobile-expanded.png), [image](assets/mobile-image.png).
[Pixel comparisons](assets/comparison.json) pass the existing gate. Small icon
placement and reasoning-style differences predate this change; no baseline was
updated. Independent unprimed inspection found no actionable layout defects.

[Choices](choices.md) records the tradeoffs behind these boundaries.
