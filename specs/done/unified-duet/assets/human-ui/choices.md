# Unified Duet human login and sync-machine UI choices

## Keep account settings together

When: UI02/04 integration.
Decision: Keep the familiar API keys navigation and show named human keys, OAuth apps, and Synced Macs as separate cards on the same account page. A named key is a login for the person; a Mac is the nonsecret identity of the computer doing file mirroring. The unbuilt alternative was another settings destination or a second sync credential form.
Gap: The request settled the identity model, but did not prescribe account-navigation structure.
Rationale: Existing account navigation already owns these tools. Keeping one page removes the former grant picker without creating another management path. The Mac card explains its independent removal explicitly.
Consequence: Removing one Mac updates that row to Removed, keeps the other Mac usable, and preserves the ordinary key-revocation controls. Explicit CLI install can enable that Mac again; the account screen does not invent a new reactivation flow.

## Keep the key form name-only

When: UI02 integration.
Decision: Ask only for a key name. The typed API retains optional expiration, but this pass does not add an expiration picker. The unbuilt alternative was a larger form with expiry presets.
Gap: The endpoint permits expiry without requiring a new UI control.
Rationale: The user asked for a simpler consumer login. A name distinguishes ordinary account keys without asking users to configure workspace authority. Current memberships and roles determine access.
Consequence: Keys created here use the API default expiration behavior; clients can still request an explicit expiry through the API. The secret stays local to the current page mount and is shown once.

## Invalidate old persisted browser data once

When: UI02/04 integration.
Decision: Advance the shared web cache schema from 15 to 16 and rename the sync-machine query resource. The unbuilt alternative was an adapter reading old credential/device cache objects.
Gap: The replacement contract removes grant fields and credential-based machine identities, but does not prescribe cache migration.
Rationale: The contract's existing cache-version owner is the smallest boundary that prevents old saved payloads being drawn under the new model. No compatibility parser or second data registry is needed.
Consequence: The first new-version browser load fetches fresh account data; subsequent loads use the normal cache.

## Preserve readable metadata on narrow screens

When: final visual review.
Decision: Wrap Added and Last used dates for Macs on mobile, allow long OAuth names and metadata to wrap, and identify revoked OAuth rows with their existing status badge rather than dimming the whole row. The unbuilt alternative kept ellipses and faded labels.
Gap: The request did not prescribe row layout.
Rationale: Fresh screenshots showed the useful dates disappearing at the mobile width and revoked-app text losing contrast. The revised production components retain the existing controls while preserving those facts.
Consequence: Long app rows can be taller, and the desktop/mobile OAuth baselines are deliberately updated. Each control still has a distinct accessible name. The familiar trash icon is retained across settings; card titles and explanatory copy supply the visible action context.

## Use a focused browser journey and production owners

When: verification integration.
Decision: Add a short account-login visual journey using the actual SPA route and deterministic API fixture, while retaining the live staging device journey's two approvals and denial. The unbuilt alternative was rerunning the much broader settings journey as the edit loop or testing a new stand-alone replica component.
Gap: The request specified the resulting behavior, not its test owner.
Rationale: The short journey exercises named-key creation, one-time-secret disappearance after leaving the route, and independent removal through the real UI. The live journey uses only {userCode} approval and compares minted-key memberships and role capabilities to the actual browser identity.
Consequence: Docker verification remains focused. Live staging execution stays a parent closeout gate; no live deployment or customer resources were changed in this pass.
