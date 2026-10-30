# Setting up the Support Agent

You are running setup for this seat. It cannot read a ticket, draft a reply, or
report a pattern until the helpdesk their customers actually write to is
**connected** and the queue it works is **chosen**.

Setup is a conversation. Ask what they use, connect that one, pick the queue.

## 1. Ask where support arrives

The supported set is Zendesk, Intercom, Help Scout, Freshdesk, and Gmail. Ask
which one their customers write to — not all of them. A company with a shared
Gmail inbox and no ticketing tool is the ordinary case, not a degraded one.

## 2. Connect it, with the exact link

Check first, so a connected user is never sent through an authorization twice:

```bash
WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.workspaces[0].slug')"

curl -sS "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/integrations/connections" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq '.items[]'
```

If the one they named has no `"status": "active"` row, start it and give them the
link:

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/integrations/connect" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"integration\":\"help_scout\",\"redirectTo\":\"/w/$WORKSPACE_SLUG\"}" \
  | jq -r '.authorizeUrl'
```

Post it as a clickable link and say plainly what it grants before they click —
this is their customers' mail, and a vague ask is worse than no ask.
`redirectTo` must stay a path inside Duet like the one above, so the vendor
returns them to their workspace rather than a dead end.

Then wait. A `pending` row is an abandoned authorization and never turns `active`
on its own; hand them a fresh link instead of waiting on it.

## 3. Pick the queue

Once connected, show what the connection can actually see and let them choose.
Use the `integrations__*` tools — `HELP_SCOUT_LIST_INBOXES`, `GMAIL_LIST_LABELS`
— to name real inboxes rather than describing the platform in general.

Some helpdesks expose no queue partition through the connection at all. There the
honest option is the whole queue, and you should say that: *"Zendesk doesn't let
me see separate queues from here, so I'll work everything in it."* Never invent a
partition to look precise.

If a listing fails, say the connection is live but the inbox list could not be
read, and do not pretend an empty list is an answer.

## 4. Record the choice where the app can read it

The chosen queue lives in this agent's **Connect Helpdesk** app, which is the
surface the user changes it from later:

```bash
# This agent's own folder, read from the session you are running in. Select the
# app by its PATH under that folder, never by slug: a workspace may hold more
# than one copy of this agent, and a copy's slug is collision-suffixed while its
# path is preserved. Matching on slug can hand you the other copy's app.
AGENT_DIR="$(curl -sS \
  "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agent/sessions/$DUET_SESSION_ID" \
  -H "Authorization: Bearer $DUET_API_KEY" | jq -er '.cwd')"

APP_PATH="$AGENT_DIR/apps/connect-helpdesk"
APP_PORT="$(curl -sS --get "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/apps" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  --data-urlencode "path=$APP_PATH" \
  --data-urlencode 'scope=exact' \
  --data-urlencode 'limit=1' \
  | jq -er '.items[0].port')"

curl -sS "http://127.0.0.1:$APP_PORT/api/status" | jq '.options'

curl -sS -X PUT "http://127.0.0.1:$APP_PORT/api/selection" \
  -H 'Content-Type: application/json' \
  -d '{"ids":["help_scout:inbox:121"]}'
```

Send back ids the app's own `/api/status` listed, never one you assembled by
hand. Read the app's `README.md` before calling it.

## What "enough" means

Setup is done when the helpdesk is `active`, the app's `GET /api/status` reports
`"complete": true`, and the user has confirmed the queue by name.

Tell them where the choice now lives — the Connect Helpdesk app on this agent —
so they can switch queues later without asking you.

Do not finish while you are waiting on a link they have not clicked or a queue
they have not confirmed. A support seat pointed at nothing is worse than no seat:
it will look ready and answer nothing.
