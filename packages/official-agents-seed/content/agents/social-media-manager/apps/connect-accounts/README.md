# Connect Accounts

The Social Media Manager's scope page. It shows which platforms are connected
(X/Twitter, LinkedIn, Instagram, Facebook, TikTok, YouTube) and holds the tick
list of accounts the agent may post to. The agent's onboarding chat connects the
platforms and makes the first picks; this page is where the user changes them. `state.json` is
runtime data, created on first save and persisted atomically beside the app;
do not edit it, `page.html`, or `server.ts` to change scope.

A later session reads and changes scope through this HTTP API at
`http://127.0.0.1:$PORT`. Committed changes are followed by an SSE
invalidation, so an already-open page refreshes without a reload.

## Completion contract

`GET /api/status` is the agent-readable truth. A connection to a platform is
one account, so each **active** connection is one option, and completion
follows the chosen account itself: `complete` is `true` only when a saved,
non-empty selection exists and every selected account's connection is still
present and active. A removed or replaced connection flips `complete` back to
`false` — even if the platform is still connected through a different account
— while preserving the selection.

`complete` is this page's own word for "pointed at something", not a product
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
  "providers": [{ "integration": "twitter", "name": "X (Twitter)", "connected": true, "status": "active" }],
  "options": [{ "id": "twitter:account:abc123", "integration": "twitter", "label": "@acmesocial", "detail": "X (Twitter)" }],
  "discovery": [{ "integration": "twitter", "state": "ok" }],
  "selection": [{ "id": "twitter:account:abc123", "integration": "twitter", "label": "@acmesocial", "detail": "X (Twitter)" }],
  "complete": true,
  "confirmedAt": "2026-08-09T12:00:00.000Z",
  "checkedAt": "2026-08-09T12:34:56.000Z"
}
```

Option ids embed the platform connection id. Labels are the account's real
handle when the platform's "who am I" call answers (best-effort, cached until
`/api/refresh`); when it does not, the account is still listed under the
platform's name — the connection is real either way, only the label degrades.

`ready: false` means the app could not reach the Duet API at all; nothing else
in the body should be trusted, and `message` says so in the user's words.

## API

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/status` | Full status above (cached up to 10s) |
| `POST` | `/api/refresh` | Same body, forced fresh (also re-asks each platform who the account is) |
| `PUT` | `/api/selection` | `{ids: [...]}` replaces the scope with option ids currently listed in `options`; `409` if an id is no longer offered; empty list clears scope (and completion) |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

Example:

```bash
curl -sS "http://127.0.0.1:$PORT/api/status"

curl -sS -X PUT "http://127.0.0.1:$PORT/api/selection" \
  -H 'content-type: application/json' \
  -d '{"ids":["twitter:account:abc123"]}'
```

## Where the real calls live

`duet.ts` is the app's entire outward edge — every network call goes to the
Duet API with the app's own runtime key (`integrations` capability): `whoami`,
the connection list, and single provider calls through
`POST /v1/integrations/composio/execute/:toolSlug` (the route documented by
the `composio-credentials` skill). The app never talks to a social platform
directly and never persists a credential. The per-platform identity tools are
declared in `PLATFORMS` at the top of `server.ts`.

Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`, and
`$DUET_APP_API_KEY`.
