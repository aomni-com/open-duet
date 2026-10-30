---
name: build-apps
target: sandbox
description: Build and ship apps in Duet. Use when making, deploying, or publishing an app, site, or service, exposing a running service, or editing an existing app.
---

# Build Apps

Build and operate apps through Duet's REST API. The sandbox provides
`$DUET_API_URL` and its own build-time `$DUET_API_KEY` for API access, plus
`$DUET_GATEWAY_BASE_URL` for approved model access. Session input sent with the
sandbox key is attributed to Duet itself, while a registered app's runtime
`$DUET_APP_API_KEY` authors input as that app — which is why the sandbox key is
not the credential the finished app uses at runtime.

## Triggers

Use this workflow when you make, deploy, or publish an app or site, expose a
service, or edit an existing app. Keep an existing app's identity when you
change it; updates happen in place.

## Which Surface

Pick by what the visitor gets, not by file count or navigation:
**app = runs/renders → app URL**; **publish = shows source → publish viewer URL**.
An app executes code or serves a rendered page, and its URL returns that running
result; a publish exposes a file or folder as readable source, and its viewer URL
shows that source and never hosts or runs a site. A folder people should read is
a publish even with many files; a site that should render is an app even as one
file.

- A service runs code — a full-stack UI with an API, or any long-running
  process.
- A static app renders static assets on its own subdomain — hydrated
  navigation, a single-page app, or plain HTML/CSS/JS meant to display.

Use the app workflow below for services and static apps. Use the `publish` skill
to show a file or folder as source.

## Externally hosted apps

When the user asks for Vercel or another external host, keep that deployment
workflow and read [reference/external-hosting.md](reference/external-hosting.md)
before building. Reuse or register a normal visible static tracking app with the
external server's `apiScopes`, including `services` for models. Its small page
says **externally hosted**, explains what the app does, and links to the actual
URL when known. This intentional inventory page differs from a placeholder
created merely to hide a publish-early registration failure.

Export a fresh app credential, capture it in memory and install it through
stdin in the host's server-side secret store before deploying. Do the Duet setup
as part of the app build; never ask the human to export or copy a key, use a
human-key fallback, or read VM private credentials. Use explicit expiration
`never` unless the user requests a finite lifetime. The reference supplies the
actual `duet app credentials` commands, an executable API alternative for an
older installed CLI, and rotation/revocation recovery. Both managed and exported
keys authenticate as the app using standard bearer authentication.

## Blessed Stack

For a code-running app, default to:

- Bun and Hono.
- One process listening on `$PORT` and serving both the API and static assets.
- A SQLite file stored inside the app folder when persistence is needed,
  through `bun:sqlite`.
- No build step unless the user asks for one or the chosen dependency requires
  it.

## Majestic Monolith

Duet apps are majestic monoliths: one process, one server, one folder. The UI,
the API, and the database all live in that single process — no separate database
service, no second tier to deploy, no queue, cache, or broker to operate. Reach
outside the app folder only when the user explicitly asks for it.

SQLite is the default database, not a compromise. It holds millions of rows and
serves thousands of reads per second from one machine, far more headroom than a
personal app — or a public one — will ever use. Open it in WAL mode
(`PRAGMA journal_mode = WAL`) so readers never block the writer, and keep write
transactions short; serialized writes are the only real constraint.

Value simplicity and maintainability above everything else, including
performance and imagined future scale. The next agent to open this app has never
seen it and gets one session to change it, so prefer plain SQL over an ORM, a
handful of files over a layered architecture, and `CREATE TABLE IF NOT EXISTS`
on boot over a migration framework. When a choice trades clarity for scale the
app will not need, take clarity.

## Project Structure

Create one folder per app in the drive. That folder is the app's anchor and
working directory; source, static assets, runtime data, and the icon all live
inside it. Keep every path in API payloads drive-relative and every icon path
relative to the app folder.

By default, create that folder **inside your own agent folder**, under `apps/`.
An app belongs to whichever agent folder encloses it, so a folder made at the
drive root becomes the workspace's own agent's app: the user finds it listed
there, beside work it has nothing to do with, instead of on you. Your folder is
named in the "Who you are" instructions; when it is not, find your own row in
`GET /v1/ws/{workspaceSlug}/agents` — the one whose `anchorPath` your working
directory sits in — rather than assuming the folder name matches your slug.
The workspace's own agent, whose folder is the whole drive, builds at the drive
root instead.

Everything else you make follows the same default — project folders, notes,
downloads, scratch files all live under your folder. Build somewhere else when
the user asks for it there; this is where work goes when nobody has said.

For an agent anchored at `agents/analyst`, create
`agents/analyst/apps/analytics`, put its UI and server there, and save its icon
as `agents/analyst/apps/analytics/icon.png`.

## Publish-Early Flow

Inspect the current app list, choose a unique slug, create the folder, generate
the icon as the first asset, and register immediately. Do not wait for the app
code to exist. The registration contract is:

`POST /v1/ws/{workspaceSlug}/apps`
`{path, command, apiScopes, installCommand?, port?, slug, name?, icon?}`

`apiScopes` declares the least authority the app's server code needs. Include
only capabilities for API routes that code actually calls; use `[]` when the
app does not call the Duet API. Do not request capabilities for possible future
features.

Select the current workspace slug from `GET /v1/whoami` and use it as
`WORKSPACE_SLUG` — the sandbox key is scoped to exactly this workspace, so
the list contains one entry. A static-app registration looks like this:

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"

curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"path":"agents/analyst/apps/analytics","command":"static-web-server -p $PORT -d . --cache-control-headers false","apiScopes":[],"slug":"analytics","name":"Analytics","icon":"icon.png"}'
```

A `502` response with `app_reconcile_failed` is expected when registration
precedes the code. The app remains registered, visitors see a building page,
and it self-heals within about 30 seconds after the code lands. Do not add a
placeholder `index.html` merely to avoid this response.

When anonymous access is intended, change visibility through
`POST /v1/ws/{workspaceSlug}/apps/{slug}/visibility` with
`{"visibility":"public"}`. Otherwise retain the existing visibility.

## Icon Protocol

Every user-facing app requires a custom icon; only a headless or API-only app
may omit it. Read [reference/app-icons.md](reference/app-icons.md), then use the
`media-creation` skill to generate a 1024x1024 PNG.
Save it inside the app folder (`icon.png` is recommended), keep it at or below
1 MB, and set `icon` during registration.

If the app already exists, set the icon with
`PATCH /v1/ws/{workspaceSlug}/apps/{slug}`. After regenerating bytes at the
same filename, PATCH `icon` with that same value; this refreshes the displayed
bytes by advancing the app's cache version.

## Static Apps

Serve a plain static app with exactly:

```bash
static-web-server -p $PORT -d . --cache-control-headers false
```

For a single-page app whose client router owns missing routes, use exactly:

```bash
static-web-server -p $PORT -d . --cache-control-headers false --page-fallback ./index.html
```

Use no other static server. Both commands are verified against the installed
`static-web-server` v2.43.0 binary.

## Freshness

App files change in place. Keep HTTP caching disabled for HTML, scripts,
styles, images, and app API responses: use `Cache-Control: no-store` in service
servers. The static commands above disable the server's extension-based TTLs;
Duet's edge enforces `no-store` for proxied app content, including existing apps.
Do not add service-worker or offline response caching unless explicitly requested.
Treat existing static-server commands without `--cache-control-headers false`
as migrations from long-lived caching. For those apps, or any service that
previously shipped long-lived caching, give changed assets new content-hashed
filenames so already-open browsers cannot reuse old scripts or styles from memory.

Verify an edit through the embedded Duet app with browser caching enabled,
including a script or stylesheet change at its normal URL. A fresh standalone
link or `curl` alone does not prove the iframe is current. Never make disabling
browser cache or using developer tools part of the user's update workflow.

## Services & Runtime

Omit `port` unless the app requires a fixed value. Duet auto-assigns a port and
injects `$PORT` into the command environment; the process must listen on it.
Use `installCommand` only for dependency installation, then keep `command` as
the single long-running process. Serve UI and API from that process and use
same-origin URLs for navigation and requests.

Change runtime fields with `PATCH /v1/ws/{workspaceSlug}/apps/{slug}`. Never
register a second copy to update an app.

When server code begins calling a Duet API route, PATCH the declaration to the
smallest matching capability set:

```bash
curl -sS -X PATCH "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps/analytics" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"apiScopes":["services"]}'
```

## External Navigation

Duet shows apps inside a sandboxed iframe. Third-party pages may refuse to be
framed, so never send the current document to one with
`location.assign(externalUrl)`. Ordinary external links use
`target="_blank" rel="noreferrer"`.

An asynchronous authorization handoff must reserve its tab with
`const popup = window.open('', '_blank')` synchronously in the click handler,
before any `await`; opening it after a fetch is liable to be popup-blocked.
Handle a blocked tab visibly, set `popup.opener = null`, navigate with
`popup.location.replace(authorizeUrl)`, and close the blank tab if starting
authorization fails. Keep the app iframe mounted so it can observe completion
through its normal refresh or SSE path.

## Your app is an interface for agents too

You are not the last agent to touch this app. Long after you finish building it,
the user will sit in a session with the app open beside the conversation and ask
for changes to what is *in* it — "add a task", "mark that one done", "clear the
list" — not to the app's code. A different agent, in a different session, will
serve those asks by calling your app.

Build for that agent now. Everything the UI can do, the API must also be able to
do; an app whose data is reachable only through its own forms leaves that future
session with nothing to call, and the user is told to go click it themselves.

Any app holding state a user might ask an agent to change is a service, not a
static app. Static serving is for content that does not change.

Document the API in a `README.md` in the app folder, together with what the app
is for and why it exists. That file is how the next agent — who has never seen
your code — knows what it may call. Keep it current: a stale README is worse
than none.

Other agents reach the app from inside the VM at `http://127.0.0.1:$PORT`.

## Keep the open page live

Someone is watching the page while an agent writes to it. They must see the
change without reloading.

Push from the server to the page over SSE, and refresh from the event. What
your frames carry is your design — a bare "something changed" nudge is enough
for most apps, a busier one may want per-resource events.

The connection crosses a proxy, so the browser will reopen it on its own from
time to time. That is normal, not an error: make reconnecting cheap and make
sure the page is correct once it happens.

The edge closes each stream cleanly at around 240 seconds, and the browser
reconnects natively in roughly 4.3 seconds.

The copy-paste pattern is in reference/live-updates.md.

## Runtime API Access

For a service Duet starts with a non-empty `apiScopes` declaration, Duet mints
a hidden key for that app and workspace after registration. The spawned service reads the platform-owned
`$DUET_APP_API_KEY` and `$DUET_API_URL` from its process environment and sends
the key as a bearer token. Each workspace mints its own key, including for an
installed or shared copy; app source never carries authority from the workspace
where it was built. An app with `apiScopes: []` receives the API URL but no app
key.

**Never hardcode a drive path.** An app does not know where it lives, and it
must not guess: the folder is named by whoever installed the agent, so the
canonical `agents/<slug>` you see in a repo is right for one workspace and wrong
for every other. Two variables answer it, both drive-relative:

| Variable | What it is |
| --- | --- |
| `$DUET_APP_DIR` | This app's own folder, always present |
| `$DUET_AGENT_DIR` | The folder of the agent that owns it — absent for an app at the workspace root, and absent until the platform has resolved it |

Build every path you read or write from those. **Treat an absent
`$DUET_AGENT_DIR` as "not ready" and refuse — never fall back to a default.** A
write to a guessed folder succeeds, so the failure is silent: the file lands
somewhere nothing reads, and any state you set afterwards says the work is done.

```bash
curl -sS -X PUT "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/files/$DUET_AGENT_DIR/notes.md" \
  -H "Authorization: Bearer $DUET_APP_API_KEY" \
  -H 'Content-Type: text/markdown' \
  --data-binary @notes.md
```

Data the app owns still belongs beside the app — `state.json` in its own working
directory needs none of this. These variables are for reaching the *agent's*
material.

**Your app can call a model.** Every app process also receives
`$DUET_GATEWAY_BASE_URL`, the workspace's model gateway, and authenticates there
with its own `$DUET_APP_API_KEY` — so the generation is billed and attributed to
the app rather than to whoever happens to be running. Declare `services` in
`apiScopes` to use it; without that scope the gateway answers
`insufficient_scope`. This is what lets an app do real work on its own rather
than hand every judgment back to a conversation: classify what a user pasted,
turn a scrape into structured settings, summarise before storing.

```bash
curl -sS -X POST "$DUET_GATEWAY_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $DUET_APP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-6-luna","messages":[{"role":"user","content":"..."}]}'
```

`GET $DUET_GATEWAY_BASE_URL/v1/models` lists the available models.

`$DUET_API_KEY` belongs to the sandbox agent while it builds and registers the
app; `$DUET_APP_API_KEY` belongs to the registered app process and has exactly
the capabilities declared in `apiScopes`. Install commands never receive the
runtime key. Do not make install-time API calls that depend on it.

Secret storage is a deployment choice. A workspace agent may save a runtime key
in a private local file or `.env` file when the app or a test needs it; the
workspace is the trust boundary. Keep that file out of source control, public
assets, browser-visible variables, and logs. For an external host, prefer its
server-side environment or secret store. Never print a key in chat or tool
output, and never ship it to browser code.

## Theme Parameter

Every UI supports `?theme=light` and `?theme=dark`. Put the detection script as
the first script in the document head, before CSS, and set `data-theme` on the
root element so the requested theme overrides the operating-system preference.
Use the copy-paste pattern in
[reference/theme-and-mobile.md](reference/theme-and-mobile.md#theme-override).

## Mobile Responsiveness

Every UI includes a viewport meta tag, global border-box sizing, fluid
containers, collapsing multi-column layouts, and tap targets at least 40 px.
Verify there is no horizontal scrolling at 400 px or below. Use the checklist
in
[reference/theme-and-mobile.md](reference/theme-and-mobile.md#mobile-checklist).

## Final Polish

Once the deployed URL works, invoke the `impeccable` skill against it. Audit and
fix both light and dark themes at desktop width and at a width of 400 px or
less. Repeat until no release-blocking findings remain, then tell the user what
was fixed and what lower-priority findings remain. Skip this only for a
headless or API-only app with no human-facing render.

## Inspect Before Mutate

Always read current state before changing it:

1. `GET /v1/ws/{workspaceSlug}/apps` before creating or choosing a slug.
2. `GET /v1/ws/{workspaceSlug}/apps/{slug}` before updating an existing app.
3. `PATCH /v1/ws/{workspaceSlug}/apps/{slug}` with only the fields that change.

Use the bearer key on every request:

```bash
curl -sS "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps" \
  -H "Authorization: Bearer $DUET_API_KEY"
```

Patch in place. Never re-register an existing slug as an update mechanism.
