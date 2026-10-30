# Compose-bar session surface

**Status:** complete. **Closed:** 2026-07-19.

## Purpose

Duet's active session belongs to the compose surface because it changes what a
message means: the same editor can continue work, answer a question, or coexist
with a sleeping run. The session panel therefore ships as an optional,
controlled capability of the existing `@repo/ui` `ComposeBar`, not as a route
overlay or a second composer.

The visual hierarchy comes from chat-app commit
`bc9078fa94f243b65d94431fe62927c87408786c`: a panel attached above the editor,
a compact working identity, concise progress, and a quiet sleeping treatment. The
source waiting state is a substantial structured-question flow; Duet Cloud
adapts its current-question hierarchy to the existing free-text answer contract
while using its own REST/SSE API and design system.

## Why the boundary looks this way

`@repo/ui` owns presentation and transient interaction only. It cannot know
about session transport, routing, React Query, localization, or Duet asset
locations. The web app converts its snapshot and projection into the
provider-free `ComposeBarSession` contract and supplies labels, its canonical
agent avatar, mutation
state, and callbacks.

This boundary keeps the compose bar reusable and makes malformed `unknown`
payloads a web concern. It also avoids replaying durable history: the existing
projection remains authoritative for the timeline, while the panel shows only
the current session state.

The phase mapping is intentionally smaller than the transport vocabulary:

| Duet status | Compose phase | Reason |
| --- | --- | --- |
| `running` | `working` | Current progress and the proven Interrupt mutation are actionable. |
| `ask` | `waiting` | The current question belongs beside the existing free-text answer composer. |
| `sleep` | `sleeping` | Sleeping is informational because no cancellation contract is proven. |
| `complete`, `interrupted` | omitted | Terminal work is durable history, not active composer state. |

## Invariants

- `ComposeBar` is the only high-level compose owner. The session surface stays
  optional, controlled, and provider-independent.
- The public submission contracts are unchanged. In particular, answering
  remains exactly `{ answer: string }`.
- Only `composeSessionFromApi` normalizes session todos and current questions.
  Invalid records fail closed; installed todo IDs must be nonblank and stable.
- Installed todo statuses retain their meaning. Active-item inference is limited
  to the legacy `{ text, done }` fixture shape.
- `composeSessionQuestionText` is shared by the active panel and durable
  timeline so the two surfaces cannot interpret question data differently.
- The panel is the sole active Interrupt affordance. Pending, failure, disabled,
  and retry states come from the existing mutation owner.
- Motion is decorative. Reduced motion removes progress-spinner animation
  without hiding state.
- The panel and editor remain one disabled unit, and mobile mutation targets
  remain at least 44 pixels.

## Decisions and rejected paths

- The source app's Convex providers, typed sandbox rows, structured option
  questions, draft persistence, mentions, audio, and thread controls were not
  copied. Duet Cloud has no matching public contracts for them.
- A speculative `pending` compose phase was rejected. Todo `pending` is an item
  status; the session itself remains `working`.
- Promoting the first installed pending todo to active was rejected after the
  live installed shape proved `pending` meaningful. Only the legacy fixture
  receives that inference.
- Separate question parsers for the panel and timeline were rejected after they
  disagreed on installed `{ question }` records.
- A shallow mobile scroll fade left clipped text and tool fragments at the
  timeline boundary. The final mobile mask reserves a fully occluded zone before
  fading content in; desktop retains its original bottom fade.
- A toolbar click could blur the editor before applying rich-text intent. The
  toolbar now preserves focus on pointer-down, keeping the existing editor
  contract intact.

## Code and test pointers

- Public contract: `ComposeBarSession` and `ComposeBarProps` in
  `packages/ui/src/components/compose-bar/types.ts`.
- Package presentation: `ComposeBarSessionPanel` in
  `packages/ui/src/components/compose-bar/compose-bar-session.tsx` and the
  existing `ComposeBar` owner in `compose-bar/compose-bar.tsx`.
- Web normalization: `composeSessionFromApi` and
  `composeSessionQuestionText` in `apps/web/spa/sessions/compose-session.ts`.
- Product mapping: `SessionDetail` in `apps/web/spa/routes/sessions.tsx`.
- Contract tests: `apps/web/spa/sessions/compose-session.test.ts` and
  `apps/web/spa/routes/sessions.test.tsx`.
- Product and package behavior/visual coverage:
  `apps/web/tests/visual/playground.spec.ts`.
- Package usage principles:
  `packages/ui/src/components/compose-bar/README.md`.
- Independent review record: [screening evidence](evidence/screening.md).

## Visual provenance

The source reference was chat-app's
`compose-bar-session-panel-session-status-section.tsx`,
`compose-bar-session-panel-todos-section.tsx`,
`compose-bar-session-panel-questions-section.tsx`, the panel owner,
and `ai-avatar.tsx` at the commit named above. No source screenshot was imported
as a pixel-perfect baseline: its attached status/progress hierarchy was the
design reference, while Duet Cloud's canonical agent identity, free-text waiting
contract, tokens, and responsive shell determined the result.

The durable target captures are:

- [working panel](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/compose-bar-session-working.png)
- [waiting panel](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/compose-bar-session-waiting.png)
- [sleeping panel](../../../apps/web/tests/visual/__screenshots__/desktop/playground.spec.ts/compose-bar-session-sleeping.png)
- [mobile running product state](../../../apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/sessions-answer-success.png)
- [mobile action failure state](../../../apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/sessions-mutation-error.png)

These captures pin the attached silhouette, canonical working identity, compact todo density,
waiting/sleeping hierarchy, action feedback, and mobile reachability.
