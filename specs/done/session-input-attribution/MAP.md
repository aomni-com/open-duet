# Session Input Attribution — Unknowns Map

This map records the completed `explore-unknowns` walk. There are no unresolved product choices; implementation feedback may still trigger reslicing at the explicit seams in the slice files.

## Known knowns

- Duet's durable session timeline already assigns every event a monotonic `seq` and row `createdAt`.
- Input events currently duplicate time in `submittedAt` and optionally carry an `origin`; the API accepts a session-only origin field.
- The current runner composer sends primary input as raw text and queued notes in a plaintext delimiter block, without sender or time.
- History already supports `cursor=<seq>` and returns events strictly after the cursor. The default start-session skill already teaches the basic polling pattern.
- The web projection carries origin, and unattributed human rows are rendered as though the current viewer authored them.
- API authentication exposes credential kind, current user, and registered app identity. App and VM credentials can share an owner-shaped `actorId`, so that field cannot identify message authorship.
- `agentSessionEvents` rows are `{seq,event,createdAt}`. A required sender belongs inside the three durable input event variants, not on every event row.
- Chat-app's live runner envelope includes timestamp and human name/email but has an unescaped interpolation bug and a message id that Duet does not need.

## Known unknowns — settled

- **Human identity:** resolve the current full name when present and current email at delivery time. Persist only `userId`; never show that id to the model.
- **Durable locator:** expose `seq`, not a synthetic message id. It directly addresses the existing strictly-after history cursor.
- **Sender vocabulary:** truthfully distinguish user, registered app, source session, and system with one required discriminated union.
- **Event vocabulary:** rename `user_prompt` and `user_note` to neutral `prompt_submitted` and `note_submitted`; the sender, not the event type, says who authored input.
- **Persistence location:** require `event.sender` on `prompt_submitted`, `note_submitted`, and `answer_submitted`; do not add a universal row-level user id.
- **Clock:** event-row `createdAt` is the sole input time and renders as ISO UTC. Delete input `submittedAt`.
- **Request surface:** derive user/app/system from authentication. Nested creation derives session sender from its parent path. Message, note, and answer accept `sourceSessionId` and validate it in the addressed workspace.
- **Workspace trust rule:** any caller with the `sessions` capability may use `sourceSessionId`; it is asserted provenance within one trust domain, not a key-kind security boundary.
- **Model grammar:** sender-specific XML-like message/note elements with exact `seq` and `timestamp` attributes; humans add `user_full_name?` and `user_email`, apps add `app_id` and `app_slug?`, sessions add `session_id`.
- **Escaping:** escape every attribute and body. User content cannot close or forge an envelope.
- **Queued notes:** retain each note's sender, sequence, and timestamp inside `<queued_notes>`, then render the primary input after the group.
- **System input:** plain body inside `<system_message>` with no nested `<system-reminder>`. Upstream agent reminders stay separate.
- **Answers:** retain the explicit API answer event and current free-text runner transport; render it with `kind="answer"`. Native structured runner answers are deferred.
- **History:** expose typed identity-only sender in the existing event. Do not add resolved display metadata or a second before-cursor API.
- **Web:** resolve current people/apps/sessions in the browser and show the actual author; optimistic browser input explicitly uses the current human sender.
- **Idempotency:** sender participates in fingerprints and equality. Reusing one `clientRequestId` with changed sender is a conflict, not a sender-partitioned namespace.
- **Compatibility:** none. Wipe data and remove the old schema and its owners completely.

## Unknown knowns — codebase facts that changed the plan

- `SECURITY.md` explicitly lists fields accepted only from `system_vm` as forbidden key-kind carve-outs. The earlier system-only idea was therefore replaced with capability-uniform `sourceSessionId` handling.
- The VM credential already has `sessions`; docs and the build-apps skill claiming it cannot start sessions are stale.
- `agentSessions.userId` is used for creator/ownership, idempotent creation, drain/recovery, analytics, and browser lost-response reconciliation. It is a separate session concept and must not be deleted or repurposed as sender in this feature.
- `composeDelivery` is the choke point that already sees durable events before the gateway receives an opaque string. Backend delivery can own identity lookup and rendering without adding a new gateway protocol.
- The gateway's runner `origin: {taskId}` is unrelated task provenance and must survive precise removal of session-message origin.
- The web already has workspace member and app data, and session summaries provide titles. A page-local identity directory avoids enriching every history row or issuing per-message requests.
- `session-authored-messages` is an existing desktop/mobile playground fixture and visual snapshot, so no parallel UI workbench is needed.
- The existing selectable `sessions-and-jobs` staging journey already owns real session lifecycle fixtures. Extending it avoids a competing live-test owner.
- The start-session skill already documents the history cursor; it only needs to connect the model-visible envelope sequence to that API value.
- Earlier native structured-answer work was implemented and reverted in a broad 27-file pass, confirming that it is not an elegant addition to this attribution change.

## Unknown unknowns — risks converted into tests or firewalls

- **Attribution spoofing confusion:** request bodies never accept arbitrary user/app/system senders. `sourceSessionId` is explicitly documented as workspace-local asserted provenance and always validated against the addressed workspace.
- **Missing current user:** delivery fails as a durable-invariant violation because the contract requires current email and forbids model-visible user id. Retired users must retain their user row. Deleted app/session presentation falls back to durable IDs.
- **Current identity versus retries:** resolve identity when composing a delivery. Exact-byte tests use a stable identity snapshot; rename-before-drain tests prove current values. Do not promise identical bytes across an actual identity change.
- **Queued chronology:** note elements are sequence-sorted, but the semantic notes group stays before the primary input even when its sequences are later. Tests pin both ordering facts.
- **Envelope injection:** exact fixtures cover XML delimiters, quotes, fake closing tags, and `system-reminder` text in both identity fields and bodies.
- **Idempotency shortcut:** tests exercise the current early-return path so it cannot declare equality before sender is compared.
- **Optimistic mismatch:** browser frames remain cursor-less and reconcile by request id; tests cover a collaborator rather than only the current viewer.
- **Identity lookup cost:** browser identity data is assembled once per page/query result, never fetched per message. Backend delivery resolves only the identities needed for the composed turn.
- **Visual category ambiguity:** the fixture includes adjacent human, app, session, and system rows plus note/answer/pending states; fresh critique judges actual-author legibility rather than general transcript restyling.
- **Stale teaching:** static searches distinguish session-input origin from unrelated task/analytics origins, and generated skill bytes must be regenerated rather than hand edited.

## Resulting principles

1. Persist stable identity; resolve current presentation at the boundary that presents it.
2. One durable sequence serves ordering, model context, and history lookup.
3. One row clock describes when input became durable.
4. Authenticated provenance is derived once; no caller submits arbitrary human/app/system identity.
5. History transports identity, backend delivery renders model identity, and the browser renders product identity.
6. Hard cutovers delete superseded owners instead of preserving adapters.
