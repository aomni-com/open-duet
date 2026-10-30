# Slice 09 — Live browser call and retained view

## Contract unlocked

The production card and overlay complete a real call without navigation, then
open a read-only retained Voice conversation with transcript and playable
audio. The browser owns LiveKit transport in exactly one module.

Invoke `write-tests` before controller/projection behavior and `ui-playground`
before any visual edit.

## One browser transport owner

Add `LiveKitVoiceCallController` under `apps/web/spa/voice/`. It is the only web
module allowed to import `livekit-client`, create/join a room, publish a
microphone track, subscribe to worker state/captions/audio, or send the Slice 03
played-prefix acknowledgement.

Update `apps/web/scripts/check-boundaries.ts` so a `livekit-client` import from
any other web owner fails. Add a test that first demonstrates the firewall red
with a stray import and then green with the single allowed owner.

The controller drives the pure Slice 02 reducer; the overlay remains
presentation-only. Transport/state encoding follows the exact sequenced event
contract established by Slice 03/08 and cannot create a second state machine.

## Activation sequence

```text
Call -> pre-call disclosure -> Start -> getUserMedia
     -> POST create call -> join unique room -> active call
```

- Merely opening/closing the disclosure creates no call/session.
- Permission denial creates no call/session and stops any partial local track.
- API/connect failure after permission stops tracks, ends any created call, and
  shows a recoverable unavailable state.
- Mute changes local microphone publication only.
- End is idempotent: end/revoke API, disconnect room, stop local/remote tracks,
  enter ended state. It never interrupts Main.
- Page unload performs best-effort end plus deterministic server expiry.
- Network reconnect has the Slice 03 bounded grace. An explicitly ended call
  never reconnects and there is no old-call resume.

The browser never sees the dispatch ticket, Voice credential, Fish/LiveKit API
secret, Main session ID, or general MCP surface.

## In-call runtime mapping

- LiveKit connection -> connecting/listening/speaking.
- Worker sequenced data events -> waiting-on-Main, caption, interruption,
  unavailable, end reason.
- Stale/duplicate frames are ignored by the pure reducer.
- Barge-in stops remote Voice playback and acknowledges the played boundary
  using the Slice 03 mechanism; it does not call any Main route.
- Caption remains the current rolling spoken turn and is replaced, never
  accumulated into a local timeline.

## Retained conversation

Ended View conversation navigates through the existing session-detail path to
`voiceSessionId`. The existing route detects the joined
`channel: "voice"` summary and selects a `VoiceConversationTimeline` rather
than the text-session surface.

The Voice view shows:

- selected root/custom agent identity plus a small Voice label;
- ordered user and agent transcripts;
- one authorized audio player per retained message;
- interrupted agent turns only to their played transcript/audio boundary;
- honest ended/failure/retention-cap state.

It omits ComposeBar, resume, text submission, Main reasoning/tool history,
pairing controls, and the Voice worker as an identity. Missing/deleted audio is
shown as unavailable without breaking transcript order.

Deleting this retained conversation uses the existing session delete endpoint
but detects `channel: "voice"` before runner cleanup: it begins the backend
Voice cascade directly and never calls the workspace gateway, because a Voice
session has no text runner to discard. Text-session deletion keeps its current
gateway-first contract. Pin both branches with API tests.

## Verification

Controller tests cover permission denial, activation failure, token expiry,
unique-room join, worker unavailable, mute, stale frames, reconnect grace,
duplicate End, remote end, page unload, and track cleanup from every phase.

Integration tests prove:

- root and custom Call select the correct activation payload;
- current route does not change until View conversation;
- disclosure precedes permission and session creation;
- barge-in stops playback while Main completes independently;
- ended View points to the retained Voice session, never the Main session;
- timeline ordering, audio authorization/playback, interrupted prefix, missing
  media, root/custom identity, and read-only behavior.

## Visual and performance gates

First wire the production transport with zero presentation change, re-run the
Slice 02 active/ended shots, and require `compare-screenshots` to report no
unexplained visual drift. Run unprimed `screenshot-critique` on the live shots.

Then add the Voice conversation surface as one new visual variable. Capture
desktop/mobile normal, interrupted, media-unavailable, and retention-cap
states; compare their hierarchy to the existing ordered-session presentation
without treating the text composer as a reference requirement. Run unprimed
critique again.

Open both montages with `preview-shots` for roughly five minutes and continue
if silent. Run the named playground/coverage/asset/build gates and verify the
Slice 03 runtime-event-to-caption budget.

## Delegated decisions

- Recoverable-error copy and audio-player cosmetics consistent with existing
  components.
- Bounded reconnect duration only if Slice 03 measured and recorded it.

Not delegated: one transport owner, activation order, route behavior, state
mapping, read-only view, selected-agent identity, or Main separation.

## Non-goals

- Auto-resume, call route, in-call timeline, ComposeBar integration,
  multi-party UI, or agent detail-header entry.

## Stay-green gate

Keep Slice 01/02 screenshots, the one-network-owner firewall, session ordering,
audio authorization, locale parity, accessibility, and focused web performance
budgets green.

## Human feedback that changes this slice

Feedback about live state comprehension, player hierarchy, or ended navigation
changes this slice. Card placement and provider/policy behavior are frozen by
earlier slices.
