# Connect Search Console

The SEO Specialist's scope page. It shows whether Google Search Console is
connected and holds the **one** site property this seat works on. The agent's
onboarding chat connects the provider and makes the first pick; this page is
where the user changes it. `state.json` is
runtime data, created on first save and persisted atomically beside the app;
do not edit it, `page.html`, or `server.ts` to change scope.

A later session reads and changes scope through this HTTP API at
`http://127.0.0.1:$PORT`. Committed changes are followed by an SSE
invalidation, so an already-open page refreshes without a reload.

## Completion contract

`GET /api/status` is the agent-readable truth. `complete` is `true` only when
exactly one property is saved **and** that property is still listed by the
live connection — a revoked grant or a property that disappears from the
account flips it back to `false` while preserving the choice. Selection is
single-pick by design: `PUT /api/selection` rejects more than one id with a
`400`, because the seat's verdicts are grounded in one site's numbers at a
time.

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
  "providers": [{ "integration": "google_search_console", "name": "Google Search Console", "connected": true, "status": "active" }],
  "options": [
    { "id": "google_search_console:site:sc-domain:acme.example", "integration": "google_search_console", "label": "acme.example", "detail": "The whole domain, every page on it" },
    { "id": "google_search_console:site:https://blog.acme.example/", "integration": "google_search_console", "label": "https://blog.acme.example/", "detail": "Just this address" }
  ],
  "discovery": [{ "integration": "google_search_console", "state": "ok" }],
  "selection": [{ "id": "google_search_console:site:sc-domain:acme.example", "integration": "google_search_console", "label": "acme.example", "detail": "The whole domain, every page on it" }],
  "complete": true,
  "confirmedAt": "2026-08-09T12:00:00.000Z",
  "checkedAt": "2026-08-09T12:34:56.000Z"
}
```

The selected property's raw Search Console `siteUrl` (including a possible
`sc-domain:` prefix) is the option id after the `google_search_console:site:`
prefix — pass it verbatim as the `site_url` argument of Search Console tools.

`ready: false` means the app could not reach the Duet API at all; nothing else
in the body should be trusted, and `message` says so in the user's words.

## API

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/status` | Full status above (cached up to 10s) |
| `POST` | `/api/refresh` | Same body, forced fresh from the platform |
| `PUT` | `/api/selection` | `{ids: [oneId]}` records the property; `400` for more than one, `409` if the id is no longer listed; empty list clears the choice (and completion) |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

Example:

```bash
curl -sS "http://127.0.0.1:$PORT/api/status"

curl -sS -X PUT "http://127.0.0.1:$PORT/api/selection" \
  -H 'content-type: application/json' \
  -d '{"ids":["google_search_console:site:sc-domain:acme.example"]}'
```

## Where the real calls live

`duet.ts` is the app's entire outward edge — every network call goes to the
Duet API with the app's own runtime key (`integrations` capability): `whoami`,
the connection list, and the site listing through
`POST /v1/integrations/composio/execute/GOOGLE_SEARCH_CONSOLE_LIST_SITES`
(the route documented by the `composio-credentials` skill). The app never
talks to Google directly and never persists a credential. A site listing that
fails is reported as `discovery.state: "failed"` and blocks completion rather
than pretending an empty account is an answer.

Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`, and
`$DUET_APP_API_KEY`.
