# Account Board

The live index of accounts researched by Account Researcher. It shows dossier coverage and generated ABM Plan/Battlecard views; `accounts.json` is runtime data, created on first write and persisted atomically beside the app.

A later session must mutate data through this HTTP API at `http://127.0.0.1:$PORT`. Do not edit `accounts.json`, `page.html`, or `server.ts` to add research. Successful mutations are committed to disk before the app emits an SSE invalidation, so an already-open page refreshes without a reload.

## Data contract

An account has `id`, `name`, optional `domain`, `status`, timestamps, `{facts}` in `dossier`, and `views`. Status is one of `queued`, `researching`, `needs-review`, or `ready`.

A found dossier fact must have this shape:

```json
{"label":"Funding","status":"found","value":"$20M Series B","retrievedAt":"2026-08-09","source":{"title":"Acme announces Series B","url":"https://acme.example/news/series-b"}}
```

`conflicting` and `stale` use the same evidence-bearing shape. An unfound field must omit `value` and `source`:

```json
{"label":"Headcount","status":"unfound","retrievedAt":"2026-08-09","note":"Crustdata and the company site returned no current figure."}
```

The API rejects a found fact without a value, HTTP(S) source URL, or retrieval date. This is deliberate: unsupported specifics are worse than thin research.

## The views

A view's `content` is Markdown and the board renders it — headings, both list
kinds, tables, quotes, code spans, and links. Send the artifact's own text
rather than a flattened plain-text copy, and never HTML: the renderer builds
nodes, so markup arrives as the characters you sent. Bold and italics are read
in their `**asterisk**` spelling only, because `_` belongs to the identifiers
these deliverables quote. An evidence id like `[E-002]` is left alone; a link
needs its `(url)`.

Keep sending the artifact whole, title line included: the card is already
labelled with `title`, so a leading `# ` heading repeating it is dropped rather
than printed twice. Nothing else is removed.

## The buying group

`PUT /api/accounts/:id/contacts` replaces the whole contact set, because re-ranking a buying group is one decision rather than a series of edits. Every contact needs a `profileUrl` (where they were found) and a `reason` — one line saying why they are on the list. The API refuses a contact without one: a list of five titles and no reasons is the thing this section exists to not be.

```json
{"id":"jordan-hale","name":"Jordan Hale","title":"VP of Engineering",
 "profileUrl":"https://www.linkedin.com/in/jordan-hale",
 "reason":"Owns the platform team named in the Series B hiring plan [E-002].",
 "roles":[{"title":"VP of Engineering","company":"Acme","start":"2022-03"}],
 "email":{"status":"found","address":"jordan.hale@acme.example","verification":"DELIVERABLE","retrievedAt":"2026-08-13"}}
```

Email carries FullEnrich's own verdict — `DELIVERABLE`, `HIGH_PROBABILITY`, `CATCH_ALL` — rather than being flattened to "found", and an address the provider did not return is `{"status":"unfound"}` with no `address`. Never assemble one from a pattern.

**A replacement keeps what the user paid for.** A contact still on the list by the same id keeps their photo and their phone number; only the ranking, reasons, and researched fields are rewritten.

### The phone button

`POST /api/accounts/:id/contacts/:contactId/phone` is the only route in this board that spends money, and it is wired to a button the **user** clicks. It returns `202` with `phone.state: "enriching"`, runs the lookup in the background, and broadcasts again when it settles to `found` (`number`, optional `region`), `unfound` (the provider had none — a result, not a retry prompt), or `failed` (`reason`, in the user's words). A second request while one is running is `409` rather than a second charge.

A phone number costs an order of magnitude more than a work email, which is why the agent enriches the whole set's emails in one batch and never bundles phones into it.

### Photos

`PUT /api/accounts/:id/contacts/:contactId/avatar?source=<linkedin|x>&from=<profile URL>` takes raw `image/jpeg`, `image/png`, or `image/webp` bytes up to 512 KB. Both parameters are required: the board records where a face came from so a reader can check it, and an X handle that was merely name-matched is how the wrong face gets onto the right contact. Download the bytes rather than storing a link — LinkedIn's CDN URLs are signed and expire.

## API

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/accounts` | Returns `{accounts}` |
| `POST` | `/api/accounts` | `{name, domain?}` creates a queued account; id is the slugged name |
| `GET` | `/api/accounts/:id` | Returns `{account}` |
| `PATCH` | `/api/accounts/:id` | `{status}` updates workflow state |
| `DELETE` | `/api/accounts/:id` | Deletes the account and returns `204` |
| `PUT` | `/api/accounts/:id/dossier` | `{facts: [...]}` replaces the dossier and moves status to `needs-review` |
| `PUT` | `/api/accounts/:id/views/:viewId` | `{type,title,content,generatedAt}` creates or replaces one view; type is `battlecard` or `abm-plan` |
| `DELETE` | `/api/accounts/:id/views/:viewId` | Deletes one generated view |
| `PUT` | `/api/accounts/:id/contacts` | `{contacts: [...]}` replaces the buying group, at most 25 |
| `POST` | `/api/accounts/:id/contacts/:contactId/phone` | Starts one phone lookup; `202` with `phone.state: "enriching"` |
| `PUT` | `/api/accounts/:id/contacts/:contactId/avatar` | Raw image bytes; `source` and `from` query parameters required |
| `GET` | `/api/accounts/:id/contacts/:contactId/avatar` | The stored image |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

Example:

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/api/accounts" \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","domain":"acme.example"}'

curl -sS -X PUT "http://127.0.0.1:$PORT/api/accounts/acme/dossier" \
  -H 'content-type: application/json' \
  --data-binary @dossier-payload.json

curl -sS -X PUT "http://127.0.0.1:$PORT/api/accounts/acme/views/battlecard" \
  -H 'content-type: application/json' \
  -d '{"type":"battlecard","title":"Acme Battlecard","content":"# Acme Battlecard","generatedAt":"2026-08-09"}'

curl -sS -X PATCH "http://127.0.0.1:$PORT/api/accounts/acme" \
  -H 'content-type: application/json' \
  -d '{"status":"ready"}'
```

The board holds the `services` scope for one reason — the phone button — and uses `$DUET_APP_API_KEY` only to reach FullEnrich through Duet's service proxy; the key never leaves the server. Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`, and `$DUET_APP_API_KEY`.
