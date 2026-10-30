# 08 — Default session aliases

**Repo:** Duet. Implements D1, D10, D26, D27.

## Contract unlocked

One default conversation per registered agent and one for the drive root,
addressable **without first obtaining an id**.

## API seam

Routes — `default` is an alias the server resolves, not a session id:

```text
GET  /v1/ws/{slug}/agents/{agentSlug}/sessions/default
GET  /v1/ws/{slug}/agents/{agentSlug}/sessions/default/history
POST /v1/ws/{slug}/agents/{agentSlug}/sessions/default/messages

GET  /v1/ws/{slug}/agent/sessions/default
GET  /v1/ws/{slug}/agent/sessions/default/history
POST /v1/ws/{slug}/agent/sessions/default/messages
```

Ownership — the pointer lives on the **owner row**, never as a flag or index
dimension on `agentSessions` (L3: that table already carries 8 indexes, several
4–5 columns, against Convex's 32-index cap):

- `agents.defaultSessionId: v.optional(v.id('agentSessions'))`
- `workspaces.rootDefaultSessionId: v.optional(v.id('agentSessions'))`

Behavior:

- **GET before the first message returns 404.** No empty row is created, no new
  status value is invented. This is why L4 dissolved rather than needing an
  idle-create path.
- **The first POST creates the session through the ordinary path**
  (`createSessionForInitialDelivery`) and stamps the owner pointer atomically in
  the same mutation. Concurrent first POSTs converge on one session and one
  pointer.
- Archive preserves the pointer. **Delete clears it**, so the next POST creates
  a fresh default (D17: the default session is ordinary for archive and delete).
- A pointer to a deleted session self-heals on the next POST.
- Root and agent defaults cannot collide — they hang off different rows.

Register every route in `packages/contract/src/endpoints/index.ts`, the exact
owner of the public API documentation (`:887` shows the existing create entry).

## What the human can run or see

Open an agent's default URL with no row behind it — composer, no session
created. Send the first message; reload; land in the same real session id.

## Verification gates

`bun run test` (backend + api suites), `bun run check-types`. Tests must cover:
unset-alias GET creates nothing; concurrent first POSTs produce one session;
delete-then-POST creates a new one; root and agent defaults stay distinct.

## Must stay green

Ordinary id-addressed session routes; `openOnboardingSession`'s own
open-or-create; archive, delete, and pagination; the existing index set.

## Fixed by this slice

Path alias over client-held id. Lazy creation on first message. Owner-row
pointer. No empty rows, no new status value, no new session index.

## Delegated to the implementer

The shared resolver's module name, the exact 404 body, and whether the UI route
is `/w/{slug}/agents/{agentSlug}` or a `sessions/default` form.
