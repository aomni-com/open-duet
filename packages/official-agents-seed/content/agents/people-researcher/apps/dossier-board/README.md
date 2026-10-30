# Dossier Board

The live index of people researched by People Researcher: one card per person, their photo, work history, contact channels, and the phone lookup the user spends on themselves. `people.json` and `avatars/` are runtime data, created on first write and persisted beside the app.

A later session must mutate data through this HTTP API at `http://127.0.0.1:$PORT`. Do not edit `people.json`, `page.html`, or `server.ts` to add research. Successful mutations are committed to disk before the app emits an SSE invalidation, so an already-open page refreshes without a reload.

## Two things this board will refuse

**A dossier with no confirmed identity.** `PUT /dossier` requires `identity.profileUrl` and `identity.confirmedBy` (`profile-url`, `verified-search`, or `user-choice`). A page carrying a face, an employer, and an email address is exactly the page a reader stops checking, so the parts that could be about the wrong person arrive with their evidence attached.

**A found email with no provider verdict.** `verification` is FullEnrich's own status — `DELIVERABLE`, `HIGH_PROBABILITY`, `CATCH_ALL` — carried through rather than flattened, because a reader about to send a first-touch email needs to know which one they hold. An address the provider did not return is `{"status":"unfound"}` with no `address`.

## The phone button

`POST /api/people/:id/phone` is the only route in this app that spends money, and it is wired to a button the **user** clicks. A phone number costs an order of magnitude more than every other field in a dossier, so the agent never enriches one as part of research.

It returns `202` immediately with `phone.state: "enriching"`, runs the FullEnrich lookup in the background, and broadcasts again when the state settles:

| State | Meaning |
| --- | --- |
| `idle` | Nobody has spent this yet — the only state the button acts from |
| `enriching` | A lookup is running; a second request is `409` rather than a second charge |
| `found` | `number`, optional `region`, `retrievedAt` |
| `unfound` | The lookup finished and the provider had no number. A result, not a retry prompt |
| `failed` | `reason`, in the user's words — a retry is offered because nothing was learned |

The lookup needs either a confirmed `identity.profileUrl` or a full name plus an employer (`company` or `domain`); without either it is `409` and no call is made. The app reaches FullEnrich only through Duet's service proxy using `$DUET_APP_API_KEY`, which requires the `services` scope and never leaves the server.

## Photos

`PUT /api/people/:id/avatar?source=<linkedin|x>&from=<profile URL>` takes the raw image bytes with an `image/jpeg`, `image/png`, or `image/webp` content type, up to 512 KB. Both query parameters are required: the board records where a face came from so a reader can check it, and an X handle that was merely name-matched is how the wrong face gets onto the right dossier.

Download the bytes rather than storing a link — LinkedIn's CDN URLs are signed and expire, so a stored link becomes a broken image within days.

```bash
curl -sSL "$PROFILE_PICTURE_URL" -o /tmp/avatar.jpg
curl -sS -X PUT --data-binary @/tmp/avatar.jpg -H 'content-type: image/jpeg' \
  "http://127.0.0.1:$PORT/api/people/jordan-hale/avatar?source=linkedin&from=https://www.linkedin.com/in/jordan-hale"
```

## API

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/people` | Returns `{people}` |
| `POST` | `/api/people` | `{name, title?, company?, domain?, location?}` creates a person; id is the slugged name |
| `GET` | `/api/people/:id` | Returns `{person}` |
| `DELETE` | `/api/people/:id` | Deletes the person and their photo; returns `204` |
| `PUT` | `/api/people/:id/dossier` | Replaces the researched body: `{identity, title?, company?, domain?, location?, summary?, roles[], email, highlights[]}` |
| `PUT` | `/api/people/:id/avatar` | Raw image bytes; `source` and `from` query parameters required |
| `GET` | `/api/people/:id/avatar` | The stored image |
| `POST` | `/api/people/:id/phone` | Starts one phone lookup; `202` with `phone.state: "enriching"` |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

A dossier replacement never touches `avatar` or `phone`: those are what the user spent on, and they belong to the person, not to the latest research pass.

Example:

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/api/people" \
  -H 'content-type: application/json' \
  -d '{"name":"Jordan Hale","company":"Northstar Systems","domain":"northstar.example"}'

curl -sS -X PUT "http://127.0.0.1:$PORT/api/people/jordan-hale/dossier" \
  -H 'content-type: application/json' \
  --data-binary @dossier-payload.json
```

Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`, and `$DUET_APP_API_KEY`.
