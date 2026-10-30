# Slice 02 — Voice overlay playground

Status: complete (2026-08-01). Slice 06 supplied activation credentials; Slice
09 owns the remaining live transport and retained-session navigation wiring.

## Contract unlocked

The real Call action opens the real, controlled Voice surface on desktop and
mobile. Every product state is playable without a backend. This is the first
complete browser-visible checkpoint.

Invoke `ui-playground` before editing TSX and `write-tests` before changing the
state machine.

## Single owner

Add `apps/web/spa/voice/` with:

- a pure `VoiceCallState` reducer;
- a presentation-only `VoiceCallOverlay`;
- one controlled callback contract consumed by playground and later by the
  LiveKit controller.

Lift the selected-call state to `AgentsWorkspace`, which already owns the
desktop/mobile roster composition. Render the overlay exactly once. A card
only raises `onStartVoiceCall`; it does not own a modal instance.

## Frozen state machine

```ts
type VoiceCallPhase =
  | "precall"
  | "requesting_permission"
  | "connecting"
  | "listening"
  | "waiting_on_main"
  | "speaking"
  | "interrupted"
  | "ended"
  | "unavailable"
```

The pure reducer rejects impossible backwards transitions, stale sequenced
runtime events, double End, and media callbacks after End. The production
transport added later may emit actions but may not own a second state model.

## Surface contract

- Desktop uses a compact modal; mobile uses a full-screen sheet.
- Pre-call shows selected agent avatar/name, small “Voice mode,” the exact
  disclosure “Audio and transcript will be saved to this conversation,” Start,
  and Close.
- No permission callback runs until Start is activated.
- Active call shows current rolling caption only, one state label, Mute, and
  End. It never shows the ordinary timeline, composer, Main tool activity, or
  more than one caption turn.
- Waiting names the honest dependency: “Checking with {agentName}…”
- Unavailable states that the selected agent could not be checked and offers
  retry/end actions appropriate to the failure.
- Ended shows only Close and View conversation.
- Close/End preserves the underlying route. View conversation invokes a
  controlled navigation callback but has no live route target in this slice.

## Runnable artifact

Extend the production-backed roster playground with hidden deterministic
controls for every phase, mute state, caption length, root/custom identity,
desktop/mobile viewport, and permission/unavailable reason. Clicking the real
card action must open the production overlay.

## Verification

- Reducer tests pin every allowed transition, stale-event handling, duplicate
  End, and post-end inertness.
- Component tests pin disclosure-before-permission, rolling-caption replacement,
  Mute/End/Close/View callbacks, focus trap, Escape behavior, and restored focus.
- Accessibility covers visible labels, dialog/sheet semantics, live-region
  restraint, reduced motion, keyboard navigation, and touch target size.
- Visual checkpoint A judges overlay geometry only: desktop modal and mobile
  sheet in `precall`.
- Visual checkpoint B judges state/control hierarchy only using listening,
  waiting, speaking, unavailable, and ended with geometry frozen.
- Run `compare-screenshots` for each checkpoint and then unprimed
  `screenshot-critique` on every candidate.
- Open the montage with `preview-shots` for about five minutes and continue if
  there is no feedback.
- Run the named playground target, build-output verification, coverage ledger,
  asset ledger, locale parity, and boundary checker.

## Delegated decisions

- Animation and waveform decoration, provided reduced-motion behavior and the
  one-caption rule hold.
- Exact responsive breakpoint consistent with the existing dialog/sheet
  primitives.

Not delegated: state names, copy meaning, disclosure order, controls, route
behavior, visible identity, or overlay ownership.

## Non-goals

- `getUserMedia`, LiveKit imports, API calls, retained sessions, or audio
  playback.
- User approval as a build gate.

## Stay-green gate

Keep the roster tests/baselines from Slice 01, pure reducer tests, locale parity,
web boundaries, and all named playground ledgers green.

## Human feedback that changes this slice

Feedback about modal/sheet geometry, hierarchy, caption density, disclosure,
or control labels changes this slice. Provider latency, transcript accuracy,
and retained conversation layout do not.

## Implementation handoff — 2026-08-01

Complete. `apps/web/spa/voice/` now owns the pure phase reducer and the one
controlled overlay used by both `AgentsWorkspace` and the roster playground.
The workspace captures the exact Call trigger before opening and restores it
after Close; on mobile it restores the roster trigger because the card rail is
closed beneath the full-screen call.

The playground drives every phase without permissions, network, or LiveKit.
Its browser checks pin the disclosure boundary, selected root/custom identity,
one rolling caption, stable active-state geometry, permission-specific
recovery, retry routing, Mute/End/Close/View callbacks, Escape behavior, and
focus restoration. Twelve desktop/mobile tests pass for the named
`agent-roster` Docker target, with six committed call-state shots per viewport.

Review corrected four failure modes before landing: active-state content was
clipped in the first bounded desktop layout; End originally retained the last
caption; microphone denial originally blamed Main; and `bg-primary/8` did not
generate CSS. The final surface gives retry priority over End when unavailable,
uses a fixed two-line caption viewport so phase changes do not jump, and leaves
mobile bottom padding safe-area-aware. No transport or live navigation owner
was added; Slice 09 supplies both.

**Downstream owner:** Slice 09 connects this frozen overlay state machine to the
Slice 06 activation seam and retained Voice session.
