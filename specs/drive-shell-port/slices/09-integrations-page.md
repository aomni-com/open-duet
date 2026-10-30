# Slice 09 — Integrations reference hierarchy

**Depends on:** slice 02. May run in parallel with Agents/Drive.

## Contract unlocked

Port the mounted Integrations page's hero, section rhythm, connected roster,
and catalog browser over Duet's existing REST-backed controller.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Port the reference gradient hero, max-width/vertical rhythm, icon section
  headings, connected rows, catalog container/cards, search, and loading/empty
  presentation directly.
- Copy `duet-integrating.png` only after recording its source/provenance; use no
  generated stand-in that could hide framing differences.
- Map `IntegrationConnection` to real logo/fallback, name/slug, status,
  reconnect/refresh/disconnect, and count presentation.
- Map `IntegrationCatalogItem` to real logo/fallback, name, description,
  connected state, and Connect action.
- Preserve debounced server search, cursor pagination/continuation, refresh,
  connect/disconnect, callback success/cancel/error, retry, invalidation,
  permissions, and disconnect confirmation.
- Accept resolved workspace slug and canonical OAuth return path explicitly;
  clear only query parameters owned by this controller.
- Omit email inbox/rule/prompt/channel management and workflow-focus/start-chat
  cards. Do not show empty shells for them.

## API seam

The current Integrations route remains the sole React Query/mutation/OAuth
controller. The controlled surface consumes state/items/callbacks. No source
Convex/Composio module crosses repositories.

## Human review surface

Ready, empty, loading, error, search, paginated, connecting, disconnecting,
disconnect-confirmation, and every callback-notice fixture.

## Verification

- Red tests first for projection, callback query ownership, canonical
  `redirectTo`, cursor/search behavior, and omitted-section absence.
- Retain current Integrations behavior/visual states.
- Visual variable: vertical hierarchy and catalog/connected density.
- Crop the page body and mask the global top bar and provider-specific data.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and non-blocking `preview-shots`.

## Stays green

All current integration lifecycle and permission behavior.

## Feedback that changes the slice

Hero copy/art, section spacing, and card density may change. Email/workflow
semantics require a missing contract and remain report omissions.
