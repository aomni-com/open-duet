# Setting up the Code Reviewer

You are running setup for this seat. Two things have to be true before it can
review anything: **GitHub is authorized in this workspace**, and **the repos in
review scope are chosen**. Everything else it does is downstream of those.

Setup is a conversation. Check first, ask second — a workspace that already has
`gh` authorized should never be walked through a login.

## 1. Authorize GitHub

```bash
gh auth status
```

If that already reports an account, say who it is and move on.

If it does not, run the device flow and **give the user the exact code and
link**:

```bash
gh auth login --hostname github.com --git-protocol https --web --scopes repo
```

It prints a one-time code and `https://github.com/login/device`. Post both to
them — the code verbatim, the URL as a link — and say plainly what the `repo`
scope grants: reading their code and posting review comments. This seat never
merges and never pushes; say that too, because it is the question they are
actually asking.

Then wait for the command to return. If the login is refused or times out, say
what happened and offer the code again rather than reporting a connection that
does not exist.

A workspace whose owner would rather use a personal access token can pipe one to
`gh auth login --with-token`. Offer that only if they raise it — the device flow
is fewer steps and leaks nothing into the conversation.

## 2. Choose the repos in scope

List what the account can actually see and let them pick:

```bash
gh repo list --limit 100 --json nameWithOwner,description,isPrivate,updatedAt
```

Show them the real names, most recently touched first, and ask which ones this
seat reviews. Do not offer to review everything by default — a reviewer pointed
at forty repositories is pointed at none of them.

If the list is empty, that is a real answer: the authorized account can see no
repositories, and they need access on GitHub before this seat can work.

## 3. Record the scope where the app can read it

The review scope lives in this agent's **Connect Repos** app, which is the
surface the user changes it from later:

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"

# This agent's own folder, read from the session you are running in. Select the
# app by its PATH under that folder, never by slug: a workspace may hold more
# than one copy of this agent, and a copy's slug is collision-suffixed while its
# path is preserved. Matching on slug can hand you the other copy's app.
AGENT_DIR="$(curl -sS \
  "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agent/sessions/$DUET_SESSION_ID" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.cwd')"

APP_PATH="$AGENT_DIR/apps/connect-repos"
APP_PORT="$(curl -sS --get "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  --data-urlencode "path=$APP_PATH" \
  --data-urlencode 'scope=exact' \
  --data-urlencode 'limit=1' \
  | jq -er '.items[0].port')"

curl -sS "http://127.0.0.1:$APP_PORT/api/setup" | jq '.repos'

curl -sS -X PUT "http://127.0.0.1:$APP_PORT/api/selection" \
  -H 'Content-Type: application/json' \
  -d '{"repoIds":["acme/web"]}'

curl -sS -X POST "http://127.0.0.1:$APP_PORT/api/complete"
```

`GET /api/setup` probes the code host itself, so call it once the login is done
and it will list the repos for you. Send back ids it listed, never ones you
assembled by hand. Read the app's `README.md` before calling it.

## What "enough" means

Setup is done when `gh auth status` names an account, the app's `GET /api/setup`
reports `"complete": true`, and the user has confirmed the repo list.

Tell them where the scope now lives — the Connect Repos app on this agent — so
they can add or drop a repository later without asking you.

Do not finish while you are waiting on a device code they have not entered or a
repo list they have not confirmed. A reviewer with no repository will look ready
and review nothing.
