# Connect Repos

The Code Reviewer's scope page. The agent's onboarding chat authorizes GitHub and makes the first pick; this page is where the user changes it. It shows whether the user's code host is connected, lists the repositories it can see, lets the user tick which ones are in review scope, and records an explicit completion the agent can read. `state.json` is runtime data, created on first write and persisted atomically beside the app; the selection recorded there is the review scope — the agent reviews only repos ticked here.

A later session must read and change this data through the HTTP API at `http://127.0.0.1:$PORT`. Do not edit `state.json`, `page.html`, or `server.ts` to change scope. Successful mutations are committed to disk before the app emits an SSE invalidation, so an already-open page refreshes without a reload.

## Completion contract

`GET /api/setup` returns the whole state. Onboarding is done when `setup.complete` is `true`; it is set only by `POST /api/complete`, which refuses (`409`) unless the connection is `connected` and at least one repo is selected — the app never reports a completion that did nothing. If the selection later becomes empty, `setup.complete` reverts to `false`.

`setup.complete` is this page's own word for "pointed at something", not a product state — the seat is unlocked by its onboarding chat. This page cannot authorize GitHub either; it probes `gh` and reports what it finds, and `ONBOARDING.md` in the agent's folder holds the device-code flow.

```json
{
  "connection": {"status": "connected", "host": "github", "account": "octocat", "checkedAt": "…"},
  "repos": [{"id": "octocat/api", "description": "…", "private": true, "updatedAt": "…"}],
  "selection": {"repoIds": ["octocat/api"], "updatedAt": "…"},
  "setup": {"complete": true, "completedAt": "…"}
}
```

## Where the code-host call lives

All code-host access is one clearly marked section of `server.ts` (`probeCodeHost`), invoked by `POST /api/connection/check`. It shells out to the `gh` CLI — the route the `github` skill documents — asking for the login and one bounded page of repositories (`--limit 100`). Nothing else in the app knows how repos are fetched. When `gh` is missing or unauthenticated the probe reports an honest `disconnected` with a plain-language reason; an agent that fetched the repo list itself (per the `github` skill) records it via `PUT /api/repos` instead.

## API

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/setup` | Returns the full state above |
| `POST` | `/api/connection/check` | Runs the code-host probe, stores connection + repo list, returns state |
| `PUT` | `/api/repos` | `{repos: [{id: "owner/name", description?, private?, updatedAt?}], account?}` — records an agent-fetched repo list (≤ 500) and marks the connection connected; ticks for repos no longer listed are dropped |
| `PUT` | `/api/selection` | `{repoIds: ["owner/name", …]}` — replaces the ticked set; every id must be a listed repo |
| `POST` | `/api/complete` | Marks setup complete; `409` with `{error}` when not connected or nothing selected |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

Example:

```bash
curl -sS "http://127.0.0.1:$PORT/api/setup"

curl -sS -X PUT "http://127.0.0.1:$PORT/api/selection" \
  -H 'content-type: application/json' \
  -d '{"repoIds":["octocat/api","octocat/site"]}'

curl -sS -X POST "http://127.0.0.1:$PORT/api/complete"
```

The app uses no Duet API scopes — everything about the code host comes from the `gh` CLI. Run it with `bun run server.ts`; Duet injects `$PORT`.
