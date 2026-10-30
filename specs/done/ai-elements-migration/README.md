# AI Elements migration

## Overview

The session UI uses Duet-owned, AI Elements-shaped primitives for message
shells and trace-style activity groups. The primitives live in
[`packages/ui/src/components/ai-elements.tsx`](../../../packages/ui/src/components/ai-elements.tsx)
and keep Duet's CSS tokens while remaining independent of the web app and its
backend. Session projection and identity stay in `apps/web`; the adapter keeps
every projected part visible in source order.

## Why this shape

The reference design needed a running tool state that settles into a check
without changing row geometry. A spinner and check therefore share one icon
footprint, while the product supplies localized accessible labels. Native
`details`/`summary` keeps disclosure keyboard-accessible and lets the existing
lazy payload behavior remain owned by the session adapter.

Contiguous reasoning and tool parts share one trace disclosure. The adapter
keeps text, questions, lifecycle markers, and separate activity runs in their
original positions, so grouping improves scanability without changing
transcript order.

The migration adapts the current shadcn AI Elements patterns instead of adding
an AI SDK dependency or adopting its message schema. Duet tokens, Phosphor
icons, Tailwind 3, and existing product contracts are the compatibility
boundary. The shared package owns presentation; web owns projection, identity,
localization, media, and callbacks.

## Principles and invariants

- `ProjectedMessage` and `AgentMessagePart` in
  [`apps/web/spa/sessions/projection/index.ts`](../../../apps/web/spa/sessions/projection/index.ts)
  remain the source of truth for content and ordering.
- Projected visible parts retain source order. The UI does not infer, merge, or
  rewrite what an agent said; the existing transcript contract suppresses only a
  successful terminal event when its answer already streamed as text.
- A contiguous run of reasoning and tool parts is represented by one trace
  disclosure; a non-activity part starts a new run.
- `packages/ui` imports no web, contract, backend, identity, routing, or network
  code. Product-specific markers and localized labels cross the seam as props.
- Running tools show a visible spinner, completed tools show a plain check, and
  tool errors retain a muted minus. Labels remain localized by the web owner.
- Desktop and mobile use the same deterministic workbenches and screenshot
  coverage. Existing session fixtures cover ordered parts, chat, and authored
  messages; shared primitives are registered in the UI visual coverage ledger.

## Code and verification pointers

- Ordered part adaptation and lazy tool payload mounting:
  [`apps/web/spa/sessions/ordered-agent-parts.tsx`](../../../apps/web/spa/sessions/ordered-agent-parts.tsx)
- Message shell integration:
  [`apps/web/spa/sessions/session-message.tsx`](../../../apps/web/spa/sessions/session-message.tsx)
- Primitive contract tests:
  [`packages/ui/src/components/ai-elements.test.tsx`](../../../packages/ui/src/components/ai-elements.test.tsx)
- Session contract tests:
  [`apps/web/spa/sessions/ordered-agent-parts.test.tsx`](../../../apps/web/spa/sessions/ordered-agent-parts.test.tsx)
  and `session-message.test.tsx`
- Visual workbench ownership:
  `apps/web/tests/visual/playground.spec.ts` and the generated coverage ledgers

## Visual provenance

[`assets/original-tool-status-reference.png`](assets/original-tool-status-reference.png)
is the user-provided screenshot that established the original running/done
status problem. It drove the icon-only spinner-to-check transition and the
replacement of the completed square icon with a plain check. Fresh desktop and
mobile workbench captures are the regression standard for the shipped result.

## Divergence from the build plan

The plan initially described a directory of vendored components. The shipped
surface is one cohesive module because only a small set of shared primitives was needed;
keeping them together leaves one clear backend-independent owner and avoids a
directory of thin forwarding files. The existing compose bar already owned the
AI Elements-shaped controlled composer, so no duplicate wrapper or data-contract
change was introduced.
