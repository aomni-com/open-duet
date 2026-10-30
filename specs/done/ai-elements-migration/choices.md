# Final choices ledger

The entries below are the implementation decisions made where the request left
room for judgment. They are ordered from least certain to most certain.

## Sound

- **Keep the existing projection contract and adapt at the UI seam — high confidence.**
  A projected message part is the record of what the agent produced. The web
  adapter keeps stable ids, kinds, opaque fields, and order in the web-owned
  projection while passing only the presentation props and DOM markers needed by
  generic `@repo/ui` primitives. A new AI SDK message schema would force the UI to guess
  whether content was spoken or merely metadata, so it was rejected. This keeps
  future renderers honest: they receive the same ordered parts and must show
  each conversational part.

- **Use native disclosure elements — high confidence.** A user can expand a tool
  or reasoning row with keyboard controls even before client behavior runs, and
  the session adapter can mount expensive tool payloads only after `toggle`.
  A custom controlled disclosure would duplicate browser semantics and risk
  breaking the existing lazy-mount contract.

- **Keep shared primitives backend-independent — high confidence.** The UI
  package owns semantic shells, icon states, and tokenized geometry; web keeps
  localization, author identity, projection markers, media, and callbacks. This
  lets another consumer use the primitives without importing session or backend
  code.

- **Use a stable icon footprint for tool status — high confidence.** While a
  call runs, the row shows a bold blue spinner; when it settles, the same space
  contains a plain check; an error uses a muted minus. The status label remains
  an accessible localized prop rather than printed copy. This directly removes
  the visual jump and square completion icon shown in the reference.

- **Keep the existing compose bar as the composer owner — high confidence.**
  The bar already owns controlled editing, attachments, pickers, questions,
  optimistic submission, streaming, and reduced-motion behavior. Adding an
  `AIComposer` alias would create a second owner without changing the contract,
  so the migration records the existing seam instead.

- **Group contiguous reasoning and tool parts in one Trace-shaped disclosure —
  high confidence.** The screenshot showed several nearly identical rows that
  competed with the answer. The adapter now wraps each uninterrupted run of
  reasoning/tool parts in one expandable trace, while text and other part kinds
  remain in place. A single trace gives the reader one clear affordance and
  preserves the original order when different kinds of content are interleaved.

## Needs-user

- **Use a 1rem, stronger-contrast status icon — medium confidence, accepted
  provisionally.** Fresh mobile review showed the smaller spinner was easy to
  miss, so the shared icon uses `size-4` and the brand color while running. This
  is purely presentational and can be tuned if a later message-density decision
  establishes a different token.
