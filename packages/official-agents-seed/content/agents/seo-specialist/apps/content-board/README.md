# Content board

One card per article, showing the stage it is in and the artifacts each stage
wrote. The page follows the work and opens full Markdown artifacts. At the
human `review` gate, it also offers one approval action and a feedback box;
every other stage stays display-only. The open page updates without a reload.

## Run it

```sh
bun run server.ts
```

Duet assigns the port. From another process in the same workspace, call it over
loopback at `http://127.0.0.1:$PORT`.

## Stages

`opportunity → keywords → research → evidence → brief → draft → review →
publish → handoff`, plus the two ways out of the chain: `shelved` and
`blocked`.

A card enters at `opportunity` and **cannot leave it without a verdict**. The
board rejects a stage change with `409 verdict_required` when `verdict` is
null, and `409 verdict_blocks_stage` when the verdict is `reject` or `fold-in`
— those two have no article to write, so the only move left is `shelved`. This
is the agent's opportunity gate, enforced where a long conversation cannot
forget it.

## API

- `GET /api/board` → `{ stages, terminals, cards }`.
- `POST /api/cards` accepts `{ slug, title, verdict?, primaryKeyword?, note? }`
  and returns `201 { card }`. `409 slug_taken` if the slug is already on the
  board.
- `GET /api/cards/:slug` → `{ card }`.
- `GET /api/artifact?path=seo/<slug>/<file>` returns the complete Markdown file
  as `text/markdown`. Paths outside the SEO Specialist's `seo/` directory and
  paths containing traversal segments are rejected. The app uses the agent
  folder identified by `$DUET_AGENT_DIR`; if Duet has not provided it yet, the
  read refuses instead of guessing a folder.
- `PATCH /api/cards/:slug` accepts any of
  `{ stage, verdict, title, primaryKeyword, note }` and returns `{ card }`.
- `POST /api/cards/:slug/feedback` accepts `{ message }` only while the card is
  in `review`, and sends that text as a user message to the owning SEO
  Specialist's default session.
- `POST /api/cards/:slug/advance` is the review approval. It tells the owning
  agent to continue, then moves the card from `review` to `publish`. If the
  message cannot be delivered, the card stays in `review`.
- `POST /api/cards/:slug/artifacts` accepts `{ stage, file, summary? }` and
  returns `201 { card }`. Re-recording the same stage and file replaces the row
  instead of stacking duplicates.
- `DELETE /api/cards/:slug` → `{ ok: true }`.
- `GET /events` is the server-sent event stream the page listens to. Frames
  carry `{ type, slug }`; refetch the board when one arrives.

A card has the shape

```json
{
  "slug": "string",
  "title": "string",
  "stage": "opportunity",
  "verdict": "new | refresh | fold-in | reject | null",
  "primaryKeyword": "string | null",
  "note": "string | null",
  "artifacts": [{ "stage": "string", "file": "string", "summary": "string | null", "recordedAt": 0 }],
  "createdAt": 0,
  "updatedAt": 0
}
```

Slugs are lowercase `a-z0-9` with single hyphens, up to 64 characters, and they
match the article's folder under `seo/<slug>/`.

For example, after writing the opportunity verdict:

```sh
curl -X PATCH "http://127.0.0.1:$PORT/api/cards/what-is-answer-engine-optimization" \
  -H 'content-type: application/json' \
  -d '{"verdict":"new","stage":"keywords"}'

curl -X POST "http://127.0.0.1:$PORT/api/cards/what-is-answer-engine-optimization/artifacts" \
  -H 'content-type: application/json' \
  -d '{"stage":"opportunity","file":"seo/what-is-answer-engine-optimization/opportunity.md","summary":"NEW — no existing URL owns the definitional job"}'
```

Changing cards and changing this app are different jobs. The page intentionally
has no general editing controls: stage changes and artifacts come from the
agent through the API; the review gate is the one place a person can approve or
send a note. To change how the board behaves or looks, edit `server.ts` or `page.html` in
this repository; the next official-agent sync replaces installed managed
copies with these authored files.

## Storage

`board.json` in this folder, written atomically and only after the change is
committed, so an event never announces a card state that was not saved. The
file appears on the first successful write; an empty board keeps no data file.

The board holds the *index* of the work. The artifacts themselves stay in the
drive under `seo/<slug>/`; the board records their paths, and the confined
read route reads one on demand for the in-app viewer. Artifact contents are not
copied into `board.json`.
