# Compose bar

`ComposeBar` is a controlled presentation boundary for message composition. It owns the mechanics of a compose surface, but it has no knowledge of model providers, product state, uploads, persistence, or message transport.

## Ownership

The consumer owns every durable or coordinated value: the message, selected quality and reasoning level, attachment records, action state, disabled state, and submission side effect. The primitive reports intent through callbacks and never clears or persists consumer data on its own.

The primitive owns only transient interaction state that has no useful meaning outside the surface: the TipTap editor instance, whether a file drag is active, and the open state managed by its menu primitives. File intake follows the visible composer across the document, but yields to a product file dropzone; accepted files still cross the consumer callback without giving the primitive an upload lifecycle.

This split keeps the component renderable in a hermetic fixture and allows any app to connect it to local state, a form library, or a remote API without an adapter inside `@repo/ui`.

## Contract

The core loop is deliberately small:

```tsx
<ComposeBar
  value={message}
  onValueChange={setMessage}
  input={{ label: 'Message', placeholder: 'Ask anything…' }}
  quality={{
    value: qualityId,
    options: qualityLevels,
    onValueChange: setQualityId,
    label: 'Quality',
  }}
  attachments={{ items: attachments, onFilesSelected: addFiles, onRemove: removeFile }}
  onSubmit={sendMessage}
/>
```

Quality and reasoning identifiers are opaque generic strings. The primitive preserves their literal types and returns selected identifiers in the submission snapshot; it never translates them or looks them up in a registry. Quality options disclose consumer-supplied labels, detail, and scores. The same score presentation applies to primary and advanced choices so comparing them does not depend on which group holds them. An optional advanced group shares the same controlled selection, with desktop submenu and mobile expansion owned by the selector. Which agent a session belongs to is never the bar's question: the host mounts one owner and the session capability carries that identity.

Quality scores follow the same boundary: consumers supply the values and localized metric labels, while the shared selector owns their accessible, responsive presentation across compose and settings. This keeps model policy in the product without letting the two selection surfaces drift visually.

Quality is the compose bar's primary mode selector, so its current value owns the compact gradient
row and opens the full option descriptions on demand. Reasoning stays a secondary toolbar picker.
This hierarchy keeps the common composer short without hiding the policy text a user needs before
changing quality.

When the host is too short for the whole surface, the editor is the region that gives way: the
quality row, banner, attachments, and action row keep their height, and the draft shrinks and
scrolls instead of pushing the send control out of the host. A flex host that wants this must let
the squeeze reach the compose bar (`min-h-0` on the chain), which every session shell does.

Optional features are capability objects. Omitting the quality, reasoning, attachment, session, or action capability removes that surface. Attachment data stays serializable in shape, while `renderPreview` is the narrow rendering seam for product-specific thumbnails. The shared attachment card owns the file-preview silhouette across draft and submitted-message surfaces; products compose navigation and file delivery around it instead of recreating the card.

`submitAccessory` is the narrow context-control seam beside Send. Its consumer owns the control and its state; the compose bar owns only its fixed placement in the action hierarchy. It is reserved for context that changes what the pending submission will create, rather than ordinary toolbar actions.

The optional session capability presents current work immediately above the editor. Its phase, status tone, todo progress, localized status labels, working avatar, expansion state, and action intent are all controlled by the consumer. A waiting session may also supply option questions: the primitive owns only ephemeral selection, paging, collapse, and submission feedback, then reports selected question and option indexes through the capability callback. The consumer still owns validation, serialization, and transport, so `@repo/ui` never imports an agent runtime or assumes an answer payload. Free-text questions remain a plain presentation string and stay on the consumer's ordinary composer path. The status icon stays muted unless the consumer supplies a `tone` utility class, keeping the palette app-owned. The working avatar is a narrow rendering seam: the product supplies its canonical identity owner rather than asking the primitive to reproduce avatar lookup rules. Session controls share the compose bar's disabled state and honor reduced-motion preferences.

Triggers are the mention plumbing's extension point, and there is one set of rules for all of them. A trigger names its character, the tag a picked item becomes, the fields a typed query searches, and how an item turns into tag attributes — so adding one is a value, not a second copy of the suggestion machinery. Three invariants keep that true. The tag grammar has a single codec, used at both ends: a sent message renders the same tag back as the same chip, and a second parser there is exactly the divergence the shared grammar prevents. All triggers share **one** Markdown bridge, because Markdown returns a bare tag as a raw `html` token and only one extension may claim that token name — a bridge per trigger would leave the last one registered owning every tag. And an attribute with no value is omitted rather than written empty, because not every item carries every attribute and `name=""` claims an empty name rather than none.

Which rows a picker may act on is the suggestion plugin's decision alone. A capability can list a row it will not insert — an agent still awaiting onboarding is worth seeing and worth not delegating to — and the plugin owns where the highlight opens, which rows the arrows visit, and what a click or Enter commits. The picker displays that verdict and never re-decides it; a second `disabled` check in the row would be two owners of one rule, and they would eventually disagree. Enter is always consumed while a picker is open, even when nothing can be committed, because the composer's Enter-to-send shortcut stands down for the picker — a key allowed to fall through would send the half-written message.

A picker may expose a consumer-owned continuation beneath its scrollable rows. The primitive keeps
loaded choices available while it shows load, loading, or retry presentation; it never fetches a
page or decides whether another page exists. This lets a product browse a bounded collection
without turning the shared composer into a server-state owner.

The optional AI toggle is presentation-only: the consumer supplies its icon and maps the pressed state to its own transport contract. Clicking it or pressing Shift+Tab in the editor reports the same inverted pressed state; the shortcut stays inactive when the capability is omitted or disabled. This preserves the canonical compose-bar interaction without teaching the shared component about messages, notes, or any backend.

The editor uses TipTap while keeping a Markdown string as its controlled transport boundary. This preserves rich-text intent without changing the existing message API shape or leaking editor JSON into product code. There is no formatting toolbar — the surface stays quiet for the common short-message path, and Markdown remains the value's shape rather than a styling feature.

`disabled` and `submitting` are deliberately different states. `disabled` turns the surface off, for a composer with nowhere to send. `submitting` holds only Send while a request travels: the editor, attachments and pickers stay live, because the next message is often being written while the last one is still in flight, and a chat surface that freezes under the reader is the stall this split exists to prevent. Enter during a send does nothing rather than queueing a second one.

Enter submits by default, Shift+Enter inserts a new block, and a consumer can cancel the built-in Enter behavior by calling `preventDefault()` in `input.onKeyDown`. Native form submission and the imperative `focus()` handle use the same submit and focus paths.

Picking, dropping, and pasting are three ways to choose the same batch, so all three hand the whole selection to one consumer callback and the picker always opens multi-select. There is no single-file mode: a compose bar that took one file at a time would be a different surface, and the switch that used to allow it only ever served a fixture — which is how a picker can look multi-select in code and open single-select in the app.

Clipboard files attach on paste; text pasted alongside them still lands in the editor, so copying a rich document does not lose its words to its images. Large plain-text pastes become an attached text file before they mutate the editor. This keeps the short-message editor responsive while preserving the complete pasted material through the same consumer-owned attachment path as picked and dropped files.

## Composition rule

The visual order is intentional, so this is a high-level component rather than a compound-component kit. Use the named data capabilities for standard behavior and the narrow `banner`, `status`, `renderPreview`, and `classNames` seams for integration. If a new requirement needs to replace an internal region wholesale or import a product service, it belongs in consumer composition or a new primitive rather than another mode inside `ComposeBar`.

The browser fixture in `apps/web/components/playground/compose-bar-playground.tsx` is the executable integration example.

The *visual owner* can differ: coverage assigns each file to the alphabetically first fixture that transitively imports it. Read the [generated coverage ledger](../../../tests/visual/coverage-ledger.generated.json) before choosing screenshots; another fixture hosting the composer can own its symbols.
