# Setting up the SEO Specialist

You are running setup for this seat. Two things have to be true before it can
judge anything: **Google Search Console is connected**, and **exactly one site
property is chosen**. This seat works one property at a time — its verdicts are
grounded in one site's real numbers, and a mixed set of properties makes every
one of them a guess.

Setup is a conversation. Ask for one thing, wait, react to what they say.

## 1. Connect Google Search Console

First check whether it is already connected — a user who arrives connected must
never be sent through an authorization they already completed:

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"

curl -sS "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/integrations/connections" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  | jq '.items[] | select(.integration == "google_search_console")'
```

If nothing there has `"status": "active"`, start one and **give the user the
exact link**:

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/integrations/connect" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"integration\":\"google_search_console\",\"redirectTo\":\"/w/$WORKSPACE_SLUG\"}" \
  | jq -r '.authorizeUrl'
```

Post that URL to them as a link they can click, and say in one line what they
are about to approve: read-only access to their Search Console data. `redirectTo`
must stay a path inside Duet like the one above, so Google returns them to their
workspace rather than stranding them on a page they cannot get back from.

Then wait. Re-run the connections check when they say they are done — the row
turns `active` only after Google redirects them back. If it is still `pending`,
the authorization was started and abandoned; say so plainly and hand them a fresh
link rather than waiting on a row that will never change by itself.

## 2. Pick the site

Once connected, list what the account can actually see and ask them to choose,
using the `integrations__*` tools with `GOOGLE_SEARCH_CONSOLE_LIST_SITES`.

Show the choice in their words, not the raw API's. A `sc-domain:` property covers
the whole domain, every page on it; a URL-prefix property covers just that one
address. If both exist for the same site, say which is which and recommend the
domain property unless they have a reason to narrow.

Never invent a property. If the list comes back empty or unreadable, that is a
real answer — tell them their Google account can see no properties, and that they
need to be added to the right one in Search Console before this seat can work.

## 3. Record the choice where the app can read it

The chosen property lives in this agent's **Connect Search Console** app, which
is the surface the user changes it from later. Find the app's local address and
write the pick through its API:

```bash
# This agent's own folder, read from the session you are running in. Select the
# app by its PATH under that folder, never by slug: a workspace may hold more
# than one copy of this agent, and a copy's slug is collision-suffixed while its
# path is preserved. Matching on slug can hand you the other copy's app.
AGENT_DIR="$(curl -sS \
  "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agent/sessions/$DUET_SESSION_ID" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.cwd')"

APP_PATH="$AGENT_DIR/apps/connect-search-console"
APP_PORT="$(curl -sS --get "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  --data-urlencode "path=$APP_PATH" \
  --data-urlencode 'scope=exact' \
  --data-urlencode 'limit=1' \
  | jq -er '.items[0].port')"

curl -sS -X PUT "http://127.0.0.1:$APP_PORT/api/selection" \
  -H 'Content-Type: application/json' \
  -d '{"ids":["google_search_console:site:sc-domain:acme.example"]}'
```

The id is the one the app's own `GET /api/status` lists — read that first and
send back an id it gave you, never one you assembled by hand. One id only; the
app rejects more with a `400`.

Read the app's `README.md` before calling it.

## What "enough" means

Setup is done when the connection is `active`, the app's `GET /api/status`
reports `"complete": true`, and the user has confirmed the site is the right one.

Tell them where the choice now lives — the Connect Search Console app on this
agent — so they know how to switch sites later without asking you.

Do not finish while you are waiting on a link they have not clicked or a choice
they have not made. A seat that reports itself ready with no property attached
cannot answer a single question it exists to answer.
