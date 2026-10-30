# Slice 01 — Call affordance

Status: complete.

Last updated: 2026-08-01.

## Contract unlocked

Every eligible production agent card exposes one Call action at the agreed
location. No overlay, media permission, API, or LiveKit code exists yet.

This visual slice begins by invoking `ui-playground`. Invoke `write-tests`
before changing card behavior and drive the eligibility matrix red/green.

## Ownership and seam

Change the real `AgentRosterCardView` in
`apps/web/spa/drive/agent-roster-rail.tsx`. Thread an
`onStartVoiceCall(card)` callback through the existing roster composition; do
not create a mock card or a second roster projection.

The action cluster order is:

```text
overflow | Call | Train
```

Train stays the rightmost action. Call is rendered only after lock state
settles and:

```ts
card.launchable && !card.locked
```

Pinned Duet/root satisfies the rule. Broken, disabled, onboarding-locked,
orphaned, and otherwise non-launchable cards omit Call entirely rather than
showing a disabled action.

The callback carries the selected card's existing durable/root identity and
display identity. Do not introduce a second eligibility flag or Voice-specific
agent projection.

## Runnable artifact

Extend `apps/web/components/playground/agent-roster-playground.tsx`, which
already imports the production card. Its deterministic cases must show:

- pinned Duet/root with Call;
- launchable unlocked custom agent with Call;
- locked custom agent without Call;
- broken/non-launchable custom agent without Call;
- callback output naming the selected card.

The fixture remains backend-, auth-, network-, and LiveKit-free.

## Verification

- Extend `agent-roster-rail.test.tsx` beside the current locked, unlocked,
  non-launchable, and Train-position tests.
- Assert Call is discoverable by accessible name and the callback receives the
  correct root/custom identity.
- Assert Train's existing link, edge position, and locked-agent behavior remain
  unchanged.
- Add matching `en` and `es-419` copy in the same change.
- Capture a tight desktop and mobile action-cluster crop. The only judged
  visual variable is action placement/density.
- Compare against the existing roster baseline with `compare-screenshots`,
  then run an unprimed `screenshot-critique`.
- Open the shots with `preview-shots` for roughly five minutes. Feedback is
  welcome but approval is not required to continue.
- Run the focused `bun ui:check agent-roster` target and the visual coverage
  and asset ledgers required by `ui-playground`.

## Delegated decisions

- Exact Phosphor phone glyph and tooltip wording consistent with adjacent
  controls.
- Small spacing adjustment inside the existing action cluster, provided Train
  remains rightmost and the crop passes.

Not delegated: entry surface, order, eligibility, callback identity, or the
absence of a disabled state.

## Non-goals

- Opening an overlay.
- Voice state, permissions, transport, sessions, audio, or routes.
- Adding Call to the agent detail header or ComposeBar.

## Stay-green gate

Run the focused roster tests, locale parity, boundary checks, and the named
playground visual target. This slice lands as a complete card affordance even
if the runtime spike later stops the feature.

## Human feedback that changes this slice

Only feedback changing discoverability, card action order, or which existing
card states are callable changes this slice. Overlay layout and call behavior
belong to later slices.

## Completed handoff

- The production card owns the action and exposes the selected existing
  `AgentRosterCard` through one optional `onStartVoiceCall(card)` callback.
- Eligibility is pinned for root, unlocked custom, onboarding-locked,
  lock-pending, and non-launchable cards. A pending custom `agent.json` load
  cannot briefly expose Call; Train and the locked-card body keep their prior
  behavior.
- The production-backed playground records the root/custom callback identity
  without opening an overlay or introducing a backend seam. Slice 02 should
  lift this callback at the Agents workspace boundary.
- Desktop and mobile action crops verify `overflow | Call | Train`; full roster
  shots verify that the extra action does not clip or crowd card identity.
- Focused component and locale tests, type checking, boundary checks, visual
  coverage, asset checks, and `bun ui:check agent-roster` pass. Comparative
  telemetry and the final fresh-eye critique found no placement, density,
  clipping, or contrast regression after correcting the DPR-scaled mobile crop.
