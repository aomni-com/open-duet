# Slice 10 — Staging journey and closeout

## Contract unlocked

One independently selectable journey proves the complete deployed Voice
topology, privacy boundaries, Main ownership, heard-only retention, and cleanup
against live staging.

This is the only slice that consumes real staging resources. Run it once at
feature closeout, not during every local pass.

## Main-path preflight

Before deploying/running the Voice journey, send five ordinary selected-agent
default-session turns on staging and require at least four to complete. A
recent staging record reported an external `@duetso/agent` OpenAI 401 on the
observation path; if that still prevents Main completion, record the external
blocker and stop. Do not add a Voice-specific model, retry, or knowledge
fallback to make the journey pass.

## Selectable journey

Add `packages/test-harness/src/staging-e2e-synthetic` and register:

```ts
"voice-mode": {
  fixture: "workspace-browser",
  description:
    "LiveKit Voice call delegates to selected Main, handles barge-in, retains heard audio, and deletes cleanly",
  run: runVoiceModeJourney,
}
```

Pin registration/selection tests. Run only:

```sh
bun run e2e:staging -- --journey voice-mode
```

Never run `bun run e2e:staging` without `--journey` for this feature.

## Journey legs

Use one launchable custom agent so attribution and a distinct Main default
session are both observable; cover pinned root eligibility locally.

1. The custom card shows Call; locked/broken/disabled fixtures do not.
2. Call opens the disclosure without route navigation and makes no call API
   request before Start/permission.
3. Activation returns a room token and Voice session but no worker ticket or
   Duet credential.
4. The named platform worker receives dispatch metadata, exchanges once, and
   a replay fails.
5. `whoami`/MCP inspection shows the MCP audience, selected owner/call binding,
   exact three tools, and no workspace/agent/session input fields.
6. A prerecorded benign greeting is answered locally with an allowed runtime
   source and no Main request.
7. A prerecorded substantive utterance reaches the selected Main default
   session with `inputMode: "voice"`; the durable transcript is raw while the
   delivered prompt contains the ephemeral ASR reminder.
8. Voice waits honestly, paraphrases the correlated Main answer, and retains
   selected-agent Voice transcript/audio without Main reasoning/tool events.
9. A long deterministic response is interrupted. Playback stops within the
   measured budget, Main receives no interrupt, and retained audio/text end at
   the acknowledged played boundary.
10. End revokes the call credential, leaves the underlying route unchanged,
    and View conversation opens the retained Voice session read-only.
11. Deleting that session removes Voice events, call row, audio rows, and
    storage blobs; media replay returns unavailable.
12. The resource ledger deletes rooms, test agents/sessions, recordings, and
    provider artifacts even on failure.

Drive real LiveKit audio with a deterministic prerecorded Ogg/Opus publisher
so STT and playout are exercised. If Slice 03 concluded this cannot meet the
test cost/reliability budget, the spec must be resliced before this point; do
not silently substitute transcript injection in the live journey.

## Privacy and artifact assertions

Collect redacted, content-free artifacts for call state, tool-list schema,
request correlation, latency, byte/duration counts, revocation, and cleanup.
Assert that logs, screenshots, traces, and artifacts contain no ticket, bearer,
room token, transcript, or audio bytes. Confirm LiveKit agent observability has
no session upload because `record=False`.

## Closeout gates

- Run focused package tests for contract, backend, API, MCP, gateway, web,
  Python worker, and test harness.
- Run repository typecheck, lint, format, endpoint metadata, locale parity,
  boundary, visual union/coverage, and asset/build verification as required by
  the touched packages.
- Re-run the Slice 03 latency and interruption probes against the deployed
  worker; do not weaken frozen budgets in closeout.
- Invoke the project `review` skill sequence: `refactor-clean`, `code-review`,
  then `write-docs`. Resolve findings or record a genuine blocker.
- Run an independent `codex review` before presenting the substantive feature
  as done.
- Update deployment docs to name `apps/voice-worker/` and its separate LiveKit
  Cloud rail. Update MCP docs for the agent-bound query/tool surface and
  `SECURITY.md` for the external credential boundary.
- After the journey passes, use `close-spec` to archive this plan as durable
  rationale pointing to the shipped code.

## Delegated decisions

- Harness helper decomposition and redacted artifact filenames.
- Exact non-sensitive prerecorded phrases, provided one is clearly local and
  one clearly substantive.

Not delegated: real audio, all twelve legs, Main preflight, privacy assertions,
cleanup, the single named journey, or the prohibition on the full suite.

## Stay-green gate

The complete focused package/root/visual matrix and the single live journey
must be green together. A known external Main failure is reported as a blocker,
not hidden by weakening a leg.

## Human feedback that changes this slice

Only a deliberate change to live acceptance, privacy artifacts, or resource
cleanup changes this slice. The journey is not blocked on screenshot approval.
