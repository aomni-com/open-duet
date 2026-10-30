---
name: duet
target: both
description: Use Duet's public API for every task involving the Duet platform. Consult the official Duet docs to discover current capabilities, authentication, endpoints, and request or response contracts.
---

# Duet

Every Duet capability is available through the public API. Treat the product UI as a client of
that same API, not as a separate capability surface.

## Choose the Docs Origin

Derive the docs origin from `$DUET_API_URL` when it names a Duet control-plane host: replace the
leading `ctl` hostname label with `docs`.

- `https://ctl.duet.so` → `https://docs.duet.so`
- `https://ctl-staging.duet.so` → `https://docs-staging.duet.so`

For an absent, local, or custom API origin, use `https://docs.duet.so`. Call the selected value
`DOCS_ORIGIN` when combining it with the page paths below; Markdown links do not expand shell
variables. Outside a Duet workspace, start with `/getting-started` and `/api-keys` rather than
assuming `$DUET_API_URL` or `$DUET_API_KEY` is already configured.

## Capability Map

Open the relevant page under `DOCS_ORIGIN` before acting:

| Area           | Pages                                               | Capability                                                                |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Orientation    | `/`, `/getting-started`                             | Understand the platform, authenticate, and make the first request         |
| Authority      | `/api-keys`, `/workspaces`, `/device-flow`          | Manage scopes, workspace selection, credentials, and device authorization |
| Protocol       | `/errors`, `/pagination`, `/reliability`, `/events` | Handle failures, cursors, retries, streams, and resume                    |
| Agent work     | `/sessions`                                         | Start durable agent work and follow its events                            |
| Other agents   | [`references/agents.md`](references/agents.md)      | List the workspace's agents, name one in a message, message one and wait  |
| Desktop        | `/desktop`                                          | Embed, inspect, and focus the shared human-visible workspace desktop      |
| Apps           | `/apps`                                             | Register workspace folders as static apps or running services             |
| Files          | `/files`, `/file-activity`                          | Mutate workspace content and observe activity history or live changes     |
| Knowledge      | `/train`                                            | Ingest sources, inspect records, and add or recall memory                 |
| Connections    | `/integrations`                                     | Use workspace-scoped external providers                                   |
| Collaboration  | `/shares-publishes`                                 | Choose private sharing or public output                                   |
| Replication    | `/mirror-devices`, `/sync`                          | Mirror and synchronize workspace drives                                   |
| Commerce       | `/billing`                                          | Understand payer ownership, limits, and usage boundaries                  |
| Services       | `/services`                                         | Discover and call paid third-party APIs through Duet's catalog             |
| Exact contract | `/reference`                                        | Read current public methods, paths, scopes, and wire schemas              |

Use the docs root `/` to discover capabilities added after this skill shipped. Treat `/reference`
as the exact contract: do not guess methods, paths, authentication, or payload shapes from memory.

## Where a person puts a file

Ask the person to attach files directly in this chat. They land in `uploads/`
under your own folder; read them there, then organize them into the structure
your work needs. Never send a person to another screen to deliver a file.

When a message carries an attached image path, read it with your file tools
right away. The path is the image input; opening it is what makes the visual
contents available for the turn.

Send a person to a files page only when chat cannot carry the folder tree they
need to deliver or when you are pointing them to a specific file or folder in
your result; it is never an onboarding ask. Emit the link as **root-relative**
Markdown — the sandbox has no web-app URL to build an absolute one from, and the
app resolves its own same-origin links:

- `[the workspace drive](/w/<workspaceSlug>/files)`
- `[my files area](/w/<workspaceSlug>/agents/<agentSlug>/files)` — one agent's own folder

When pointing the person to a specific file or folder you created, link that
exact Drive path instead of sending them to the folder root:

`/w/<workspaceSlug>/agents/<agentSlug>/files/<drivePath>`

`<drivePath>` is the full workspace-relative Drive path with no leading slash,
not a path relative to the session cwd. Resolve a relative tool path against the
session cwd first, remove `.` or `..`, then URL-encode each path segment while
preserving the `/` separators. For example, a report at
`agents/account-researcher/reports/acme review.md` becomes:

`/w/acme/agents/account-researcher/files/agents/account-researcher/reports/acme%20review.md`

Get `<workspaceSlug>` from `GET /v1/whoami`. Get the current agent's registered
`slug` from `GET /v1/ws/{workspaceSlug}/agents`; match its `anchorPath` rather
than guessing that the folder name and slug are identical. The workspace's
default agent uses `root`. This same URL grammar opens either a file or folder.

Never prefix the link with a host you inferred (`duet.so` is not the workspace
app); a root-relative path lands on the right origin in every environment.

Never ask somebody to paste a document's contents into the conversation when
they could attach the file instead.

## Where a person sees an agent's browser

Every human-visible workspace desktop link names its agent owner, including the
workspace's default `root` agent:

`/w/<workspaceSlug>/agents/<agentSlug>/desktop`

Emit it as a normal root-relative Markdown link. Never infer an app host and
never teach a workspace-level desktop URL. Resolve `<workspaceSlug>` with
`GET /v1/whoami`; resolve `<agentSlug>` from
`GET /v1/ws/{workspaceSlug}/agents`, using `root` for the default agent. The
`workspace-browser` skill owns the tab-focus and human-handoff procedure that
must run before sharing this link.
