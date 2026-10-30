# Specific-people visual review

The visual target is a noise-scoping control that still reads as an ordinary
workspace session: `Specific people` is explicit in the empty composer, **You**
and the addressed agent remain visible, the active session header shows a
compact human audience, and archive actions stay in the existing session menu.
Desktop and responsive mobile web are both first-class surfaces.

The production playground fixtures under
`apps/web/tests/visual/__screenshots__/` own the accepted desktop/mobile states
for the composer, session header, audience manager, and lifecycle menu. The
Docker visual gate builds the optimized application before capturing them; the
fixtures drive the real session components through the public-client seam.

## Mobile header comparison

The pre-change reference is the `agent-jobs-dialog-picked.png` baseline at
`b30d0dbc5`. It showed five avatars and a repeated verbal count, leaving only a
short title prefix. The accepted candidate keeps three avatars, represents the
remaining audience as `+N`, preserves the full count in the trigger's accessible
name, and gives the back control a 44-pixel target. This keeps the session title
recognizable without hiding the audience.

- [Side-by-side](comparisons/mobile-header/mobile-header-side-by-side.png)
- [Absolute difference](comparisons/mobile-header/mobile-header-absdiff.png)
- [Metrics and artifact provenance](comparisons/mobile-header/visual-parity-diff.json)

The full-frame comparison changed 0.731% of pixels and localized the movement to
the header (`MAE 0.498`, edge-energy ratio `0.999`). The candidate is less wrong:
conversation and composer geometry are unchanged, while session identity and
the participant overflow are both readable.

Two fresh, context-free critiques were run. The first rejected the crowded
five-avatar mobile header and the low-contrast overflow treatment. After the
responsive overflow, contrast, and touch-target corrections, a second fresh
critique found no blocking clipping, overlap, or readability defect. Its
remaining notes were minor density/affordance polish: the title still truncates
after a recognizable prefix, the overlapped avatars read as a tight group, and
the status dot/caret are deliberately quiet.

The compact follow-up composer visible in the same job-dialog fixture is
pixel-identical before Slice 19 and is therefore inherited rather than evidence
of this feature's header change. It is not used to waive any Specific-people
state: the empty composer and lifecycle fixtures retain their near-full-width
mobile layouts and remain covered by the same Docker gate.

## Lifecycle and history closeout

The closeout target is a truthful session surface: server history must be
present before lifecycle controls are judged, a submitted prompt must remain
visible while its request is pending, long history must frame the newest
evidence, and the existing menu must distinguish personal archive, global
archive, and permanent deletion without obscuring the conversation.

The pre-pass reference is `7b7728959`; that pass accepted `efcc57445`.
Its session baselines live under `apps/web/tests/visual/__screenshots__/`; the unrelated
`train-loading` spinner-phase change produced by approval was rejected and
restored byte-for-byte. Full-frame telemetry over the eight accepted pairs
localized the largest movement to the formerly empty lifecycle captures
(`0.21646` mobile and `0.17578` desktop distance, with edge-energy ratios above
`1.8` because real history replaced the waiting placeholder). The other six
pairs ranged from `0.01785` to `0.12677`; their movement is confined to the
intended menu, confirmation, pending-input, and newest-history framing. These
numbers measure distance from the old images, not correctness.

The final non-updating Docker gate for the session audience, SPA shell, and
agent-jobs surfaces is green. The shared composer reserves one editable line
and bottom breathing room before surrounding panels may consume the remaining
height; in a constrained session audience view, the audience region becomes
the scrolling owner so the draft, attachment action, and Send remain usable.
The baselines in `apps/web/tests/visual/__screenshots__/` are the exact accepted
state rather than a count copied into this rationale.
The complete strict visual artifact is pinned at
`c6fef1c5ca5923cff19b5f07af6c5e2f25efdc35`; the earlier lifecycle commit above
is comparison provenance for that pass, not the final baseline owner.
The exact strict checkout reran the focused `session-audience` and
`agent-jobs-dialog` Docker gate after the final `origin/staging` merge: all 20
desktop/mobile interactions passed. Representative picker, constrained mobile
keyboard, audience-manager, and lifecycle-menu PNGs are byte-identical to the
previous accepted strict artifact, so the upstream markdown/file-preview work
did not move these session surfaces.

A final fresh, context-free critique found no blocking clipping, unreadable
primary control, destructive-action inconsistency, or capture artifact. At an
extreme mobile keyboard height, the open people picker may temporarily cover
the secondary quality/provider toolbar; closing the picker restores it while
the draft and primary send controls stay reachable. The implementation accepts
that edge-case tradeoff instead of adding another overlay-placement system.

The final strict-revision critique independently called out that same mobile
overlay, the intentionally stronger focused-row treatment beside the selected
checkmark, the compact popover width, low-emphasis remove glyphs, shared archive
iconography, and the short `Delete` menu label. None blocks acceptance: focus
and selection are distinct states, every remove control has an accessible name
and 44px target, the archive actions state their scopes in text, and permanent
delete requires a separate scoped confirmation before mutation. These remain
useful future polish candidates, but changing them during cutover closeout would
expand this edge-case feature beyond its deliberately simple interaction model.
