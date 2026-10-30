---
name: publish
target: sandbox
description: Publish a file or folder in Duet as a public, read-only source viewer. Use when asked to publish, share publicly, or expose a document, file, or folder for people to read — as opposed to building an app or site that runs or renders.
---

# Publish

Publish a drive file or folder as a public, anonymous, read-only **viewer**
through Duet's REST API. A publish **shows source**: it opens the path in Duet's
own file and folder viewer so visitors read exactly what is there. It never
hosts, runs, or renders a site — that is what an app is for (`build-apps`). A
published `index.html` is shown as its HTML source, not served as a web page.

The sandbox provides `$DUET_API_URL` and `$DUET_API_KEY`; treat both as
system-managed credentials and never copy them into files. Send the bearer key
on every request.

## Source, Not Hosting

If the visitor should read the files themselves — one document, or a folder to
browse — publish it. If the visitor should get a running or rendered result — a
site with navigation, a single-page app, a service — that is an app: stop and
use `build-apps` instead. Publishing never executes the content.

## Inspect Before Mutate

List existing publishes before choosing a slug or changing one; a path may
already be published, and a slug must be unique.

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"

curl -sS "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/publishes" \
  -H "Authorization: Bearer $DUET_API_KEY"
```

## Publish a File or Folder

Choose any drive-relative path — a single file or a whole folder — and register
it. Send only the path and an optional slug; the server auto-detects `kind`
(`file` or `folder`) from the path:

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/publishes" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"path":"reports/q3.md","slug":"q3-report"}'
```

The response row carries the assigned `slug` and detected `kind`. The public
viewer URL is:

```
https://edge.duet.so/<workspaceSlug>/<publishSlug>/
```

(Staging publishes live on `edge-staging.duet.so`.) The REST contracts are:

- `GET /v1/whoami` discovers `workspaceSlug`.
- `GET /v1/ws/{workspaceSlug}/publishes` lists existing publishes.
- `POST /v1/ws/{workspaceSlug}/publishes` registers `{path, slug?}`; `kind` is
  auto-detected server-side, so never send it.
- `PATCH /v1/ws/{workspaceSlug}/publishes/{slug}` renames the slug (`{slug}`).
- `DELETE /v1/ws/{workspaceSlug}/publishes/{slug}` removes the publish.

## Verify the Viewer

Open the viewer URL and confirm both shapes show source:

- A published **file** opens in the source viewer showing its contents. A
  published `index.html` shows its HTML source; it is never served as a live
  page.
- A published **folder** opens as a file browser listing its entries; clicking
  an entry opens that file's source.

If a published `index.html` renders as a running web page instead of showing
source, the request was misrouted — the bare publish URL only ever shows source.

## URL Grammar

Every publish lives at `edge.duet.so/<workspaceSlug>/<publishSlug>/*`. The bare
URL always returns the **viewer**. `?raw` and `?list` are reserved query
selectors on that same grammar — `?raw` fetches a single file's bytes and
`?list` returns a directory's JSON listing — used by the viewer itself; a bare
visit never returns raw bytes or a listing. Dotfiles (`.env`, `.git`, …) never
appear in a publish.

## Update or Delete

Change a slug with `PATCH`; remove a publish with `DELETE`. Never register a
second publish of the same path as an update mechanism — inspect, then patch or
delete in place.
