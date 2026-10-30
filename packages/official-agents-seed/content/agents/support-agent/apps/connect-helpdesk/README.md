# Connect Helpdesk

The Support Agent's scope page. It shows which helpdesk is connected (Zendesk,
Intercom, Help Scout, Freshdesk, or a Gmail shared inbox) and holds the tick list
of inboxes or queues the agent may work. The agent's onboarding chat connects the
helpdesk and makes the first picks; this page is where the user changes them.
`state.json` is runtime data, created on first save and persisted atomically
beside the app; do not edit it, `page.html`, or `server.ts` to change scope.

A later session reads and changes scope through this HTTP API at
`http://127.0.0.1:$PORT`. Committed changes are followed by an SSE
invalidation, so an already-open page refreshes without a reload.

## Completion contract

`GET /api/status` is the agent-readable truth. `complete` is `true` only when
a saved, non-empty selection exists **and** every selected item's helpdesk
connection is currently active — a revoked grant flips it back to `false`
while preserving the selection.`complete` is this page's own word for "pointed at something", not a product
state. The seat is unlocked by its **onboarding chat**, which connects the
provider and sets the first scope through the API below; this page is where the
user changes that scope afterwards.

There is no connect route. The provider's authorization page refuses to render
in Duet's app frame, so a Connect button here could only open a stray tab that
returns to this app instead of the product — see `ONBOARDING.md` in the agent's
folder, which holds the connect flow and passes a `redirectTo` path inside Duet.

The status body:

```json
{
  "ready": true,
  "providers": [{ "integration": "zendesk", "name": "Zendesk", "connected": false, "status": "not-connected" }],
  "options": [{ "id": "help_scout:inbox:121", "integration": "help_scout", "label": "Support", "detail": "help@acme.example" }],
  "discovery": [{ "integration": "help_scout", "state": "ok" }],
  "selection": [{ "id": "help_scout:inbox:121", "integration": "help_scout", "label": "Support", "detail": "help@acme.example" }],
  "complete": true,
  "confirmedAt": "2026-08-09T12:00:00.000Z",
  "checkedAt": "2026-08-09T12:34:56.000Z"
}
```

`ready: false` means the app could not reach the Duet API at all; nothing else
in the body should be trusted, and `message` says so in the user's words.

## API

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/status` | Full status above (cached up to 10s) |
| `POST` | `/api/refresh` | Same body, forced fresh from the platform |
| `PUT` | `/api/selection` | `{ids: [...]}` replaces the scope with option ids currently listed in `options`; `409` if an id is no longer offered; empty list clears scope (and completion) |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

Example:

```bash
curl -sS "http://127.0.0.1:$PORT/api/status"

curl -sS -X PUT "http://127.0.0.1:$PORT/api/selection" \
  -H 'content-type: application/json' \
  -d '{"ids":["help_scout:inbox:121"]}'
```

## Where the real calls live

`duet.ts` is the app's entire outward edge — every network call goes to the
Duet API with the app's own runtime key (`integrations` capability): `whoami`,
the connection list, and single provider calls through
`POST /v1/integrations/composio/execute/:toolSlug` (the route documented by
the `composio-credentials` skill). The app never talks to a helpdesk vendor
directly and never persists a credential.

Discovery per provider (in `server.ts`): Help Scout lists real inboxes
(`HELP_SCOUT_LIST_INBOXES`), Gmail lists the inbox and the user's labels
(`GMAIL_LIST_LABELS`). Zendesk, Intercom, and Freshdesk expose no queue
partition through the connection, so the honest offer is the whole queue as a
single option. A discovery that fails is reported as `discovery.state:
"failed"` and blocks completion rather than pretending an empty list is an
answer.

Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`, and
`$DUET_APP_API_KEY`.
