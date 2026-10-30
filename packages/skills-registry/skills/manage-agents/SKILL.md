---
name: manage-agents
target: sandbox
description: Create, configure, inspect, and debug Duet agents. Use when setting up an agent persona or repeatable agent process, changing an existing agent, or diagnosing its local runtime.
---

# Manage Agents

Manage anchored agent folders through Duet's REST API. The sandbox provides
`$DUET_API_URL` and `$DUET_API_KEY`; treat both as system-managed credentials
and never copy them into files. Send the bearer key on every REST request.

## Create and Register

**Ask the user what to call the agent before you create anything.** The display
name is theirs, not yours to invent — it is what they will see on the agent's
page, in the composer, and beside every session it runs, and an agent quietly
named `research-assistant` reads like a folder rather than a colleague. Ask
before the folder exists and before the POST; proposing a name and confirming it
is fine, assuming one is not.

The name is free-form: capitals, spaces, and accents are all fine, up to 32
characters — short because it also has to fit the knowledge map's centre label
and the mobile header. It is independent of the slug, which stays path-safe and is what
URLs use — so "Research Assistant" and `research-assistant` are the normal
pairing, not a contradiction. Renaming later changes only the name; the folder
never moves.

Then choose a drive-relative folder and a unique slug. Create the folder before
registration so it can immediately serve as the agent boundary.

By default, put that folder **inside your own folder**, under `agents/`. An
agent answers to the nearest agent folder enclosing its own, so one registered
inside yours becomes your child — the colleague you hand work down to, drawn
on you rather than on the workspace map. A folder made at the drive root
answers to the workspace's own agent instead and never becomes a child of
yours. Your folder is named in the "Who you are" instructions; when it is not,
find your own row in `GET /v1/ws/{workspaceSlug}/agents` — the one whose
`anchorPath` your working directory sits in — rather than assuming the folder
name matches your slug. The workspace's own agent, whose folder is the whole
drive, registers at `agents/research` instead. Register somewhere else when the
user asks for it there; this is where a new agent goes when nobody has said.

The slug is lowercase kebab-case — letters, digits, and single hyphens, no
leading or trailing hyphen, 40 characters at most — and a handful of words are
reserved by the product. `root` is the one worth knowing by name: it addresses
the workspace's own default agent, so no registration may claim it.

The slug you send is a request and is answered, never quietly adjusted. A
malformed or reserved one comes back `400 {"error":"invalid_request"}`, and one
already in use comes back `409 {"error":"conflict"}`. Both mean pick another and
retry — nothing suffixes it for you. A folder named `root` is fine; just give
its agent some other slug. Generate a
1024x1024 PNG with the `media-creation` skill, save it
inside that folder (`icon.png` is recommended, for example
`agents/analyst/agents/research/icon.png`), and keep it at or below 1 MB. The
image should be full-bleed with no rounded corners, border, frame, or text
because Duet crops and labels it.

The example below registers `Research` from an agent whose own folder is
`agents/analyst`; the workspace's own agent would use `agents/research`.

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"

mkdir -p agents/analyst/agents/research

curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agents" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"path":"agents/analyst/agents/research","slug":"research","name":"Research","icon":"icon.png"}'
```

The corresponding API contracts are:

- `GET /v1/whoami` discovers `workspaceSlug`.
- `POST /v1/ws/{workspaceSlug}/agents` registers `{path, slug, name?, icon?}`.
- `GET /v1/ws/{workspaceSlug}/agents` lists agents and their anchors.
- `PATCH /v1/ws/{workspaceSlug}/agents/{slug}` changes `name` or `icon`.
- `DELETE /v1/ws/{workspaceSlug}/agents/{slug}` deletes the agent and its folder,
  including nested agents and apps. Do not use it to unregister while keeping files;
  move any content you need to retain outside that folder before deletion.

Once registration succeeds, close by handing the user both links: the new
agent's page and its anchor folder in Drive. Emit them as **root-relative**
Markdown links — the app renders the message and navigates to them in place, no
page reload:

```md
[Research](/w/$WORKSPACE_SLUG/agents/research)
[Research](/w/$WORKSPACE_SLUG/files/agents/analyst/agents/research)
```

Use the agent's display name as the link text for both. The agent-page link ends
with its slug. For the Drive link, append the registered anchor path to the
fixed `/w/$WORKSPACE_SLUG/files/` prefix. Percent-encode each path
segment separately, never the `/` separators. Keep both links root-relative:
the sandbox has no web-app URL to build an absolute one from, and the app
resolves its own same-origin links.

The bare `…/agents/<slug>` link opens **the agent itself** — the surface a
person gets by clicking that agent's face on the map, with its conversation and
its apps. That is what to send when naming a colleague. Deeper paths name
narrower things, and every one of them is a link you may emit:

```md
[Research](/w/$WORKSPACE_SLUG/agents/research)                       the agent
[that job](/w/$WORKSPACE_SLUG/sessions/<sessionId>)                 one conversation
[its settings](/w/$WORKSPACE_SLUG/agents/research/settings)          what it is and knows
```

Use the short session link above for conversations; it needs no query parameters.

`root` is the reserved slug for the workspace's own agent, so
`/w/$WORKSPACE_SLUG/agents/root` opens it the same way. `marketplace` is
reserved too — neither may be an agent's slug.

## Inspect Before Mutate

Always inspect with `GET /v1/ws/{workspaceSlug}/agents` before choosing a slug,
registering, or changing an agent. Before a PATCH, use the returned row to
confirm the current slug and fields, then send only the changed `name` or `icon`.
Registration is not an update mechanism.

Re-registering an existing folder leaves out what you leave out: an omitted
`name` or `icon` keeps the stored one rather than clearing it. So a second POST
cannot quietly undo a rename the user made — but it is still the wrong verb for
changing metadata, because it will not tell you the agent already existed. PATCH
says what you mean.

If an existing agent has no icon, add one with
`PATCH /v1/ws/{workspaceSlug}/agents/{slug}` after that inspection. After
regenerating bytes at the same filename, PATCH `icon` with that same value so
the displayed bytes refresh through the agent's updated cache version.

## Author the Boundary

Write `AGENTS.md` as the agent's concise identity and operating instructions.
`AGENTS.md` replaces the enclosing prompt at the agent boundary; it does not
layer the agent identity over the drive-root prompt.

Skills inherit down the folder tree. The portable root is
`<agent>/.agents/skills`; put each skill at `<skill>/SKILL.md` below it. Skills
outside the agent subtree are environment-specific.

An optional `DESCRIPTION.md` beside `AGENTS.md` is what the marketplace
detail page and the agent's own settings page render instead of the whole
`AGENTS.md` — write it addressed to whoever is deciding whether to install,
not to the agent: what it does, what it needs from them, what they get.
Capped at 64KiB. Omit it and both pages fall back to `AGENTS.md` verbatim.

### `agent.json`

Behavior config. Every field is optional, and unknown fields are preserved
rather than rejected, so a config written by a newer Duet still parses here.

```json
{
  "trainable": false,
  "onboarding": { "kind": "chat" },
  "suggestedFirstMessage": "Hi — I’m your Editor. Paste a draft and tell me who it’s for."
}
```

`agent.json` contains behavior only. Never add `slug`, `id`, `agentId`,
`anchorId`, or `path`: the folder anchor and Convex row own identity.
`triggers` is reserved, inert, and optional. Nothing in this file starts a
session; an agent does nothing without one.

`suggestedFirstMessage` is what the agent's empty chat opens with, shown as a
message from the agent and recorded as its first message when the user
replies. Optional; when writing one, speak in the agent's own voice, first
person, ending with the first concrete thing to hand over. Keep it under 300
characters — it is a chat bubble, not a pitch.

Missing `agent.json` is valid. Malformed config uses the permissive reading for
the fields below: trainable, and not awaiting onboarding.

### Onboarding

Set `onboarding` when the agent needs something from the user before it can do
its job — brand colors, style references, a preferences file it writes itself.
Until that workspace marks the agent onboarded, Duet collapses the agent's card
to a single **Start setup** button; sessions, apps, and skills stay hidden.
Train remains available, and so does the management menu.

Two kinds:

- `{"kind": "chat"}` — Duet opens a conversation whose system prompt is built
  from two layers: the agent's **optional** `ONBOARDING.md`, then a
  Duet-owned block instructing the agent to mark itself onboarded when the
  interview is done — never on its first turn, and never before the user has
  written back at least once, so an agent with a thin `ONBOARDING.md` cannot
  unlock itself before the user has said a word. Write the interview in `ONBOARDING.md`. It is optional
  like `AGENTS.md` — omit it and onboarding still runs and still completes, it
  just has nothing specific to ask. What Duet never does is fall back to the
  agent's `AGENTS.md`: the user believes they are being onboarded, so running
  the ordinary persona instead would be a silent switch.
- `{"kind": "app", "app": "<path>"}` — Duet opens one of the agent's own apps.
  `app` is a **path relative to the agent folder, never an app slug**, because a
  shared copy's slug can be suffixed to avoid collisions while its path is
  preserved. A dot-folder such as `.onboarding/style-picker` keeps the app out
  of the way while it is still reachable. Add `"hideAfterOnboarded": false` to
  keep the app listed after onboarding — useful when it doubles as a settings
  screen. It defaults to `true`.

**Never use an app onboarding to connect an integration.** Every provider's
authorization page refuses to render in an iframe, and an onboarding app runs
inside Duet's app frame — so the page has to open a real browser tab, and that
tab returns to whatever the connect call named, which from inside an app is the
app's own address. The user lands on a bare second copy of the app with no way
back into the product. Use `{"kind": "chat"}` for anything that connects
something, and reserve app onboarding for settings, inputs, and uploads a page
genuinely handles better than a sentence — writing samples to drag in, a tone
dial, a long rubric. Picking one of three inboxes is not that.

The interview is the only place that can hand over a working link, because
`redirectTo` accepts a **path relative to the web app** and therefore returns
the user into Duet:

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/integrations/connect" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"integration\":\"help_scout\",\"redirectTo\":\"/w/$WORKSPACE_SLUG\"}" \
  | jq -r '.authorizeUrl'
```

Give the user that `authorizeUrl`, say in one line what they are approving, and
check `GET /v1/ws/$WORKSPACE_SLUG/integrations/connections` first so someone who
is already connected is never sent through an authorization twice. An absolute
URL on an app host is what strands them; keep `redirectTo` a Duet path.

Either way, **onboarding finishes by calling the onboarded endpoint**. That
call is what ends the experience and reveals the full agent UI — nothing else
does it.

For chat onboarding you do not write that instruction: Duet appends it to the
system prompt as its own block after your `ONBOARDING.md`, already resolved to
this agent. So `ONBOARDING.md` is purely the interview — what to ask, what to
record, and above all **what must be true before it is finished**, because that
last judgment is the one Duet cannot make for you.

An onboarding **app** gets no such help and must make the call itself. It has
its own route, because an app holds no session id and no agent slug — only its
runtime key, which is the whole address:

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/app/onboarded" \
  -H "Authorization: Bearer $DUET_APP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"onboarded":true}'
```

Duet resolves which agent's folder the app lives in. The app must declare the
`agents` scope; without it the app renders but can never finish onboarding, and
the user is left on a page whose only button they already pressed.

Onboarding conversations are ordinary resumable sessions that no list, job
view, or search will show; reopening the button returns to the same one.

Completion is **per workspace**. Share an onboarding agent and each recipient
gets the locked card and onboards independently — your completion does not
travel with the folder, and theirs does not affect yours. Adding `onboarding`
to an agent that is already installed elsewhere therefore re-locks it for
everyone who has not onboarded, on their next sync. That is the intended lever
for "everyone must go through the new setup", but know the blast radius before
you pull it.

### Training

`"trainable": false` removes the Train affordance for that agent, for authors
whose agent has no use for it. The default is `true`. This is a UI setting: it
hides the button and disables the train route, and changes nothing about
memory or what descendants inherit. The default drive-root agent is always
trainable regardless of any config.

## Start a Session

The session API is on the `duet` skill's `/sessions` page. A session is started
by sending `cwd` at the agent folder (or a descendant), for example
`{"cwd":"agents/analyst/agents/research"}`. Resolution uses the nearest
registered agent folder. Always send the folder location; never send an
`agentId` in the launch request.

`triggers` cannot create this session. Durable timer and poll states may keep an
existing session alive, but the agent does nothing until a session is created.

## Debug Locally

Find `anchorId` with `GET /v1/ws/{workspaceSlug}/agents`, then tail the log for
the returned row. The per-agent log is
`~/.duet/agents/<anchorId>/logs.log`:

```bash
tail -n 100 -f ~/.duet/agents/<anchorId>/logs.log
```

For the default drive-root agent, tail `~/.duet/logs.log`.
Logs and runtime state are local and unsynced.
Curated memories live under the applicable agent folder in the drive, so they
sync and travel with that agent's ordinary content.

## Sharing Constraint

Do not create overlapping agent-share and nested app-share roots. Nested share
roots are unsupported; choose one share boundary rather than presenting a
separately nested app share as a working setup.
