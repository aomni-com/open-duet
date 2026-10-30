# Your apps

This is a snapshot of the apps available to this session when the session started.

- **Hello** (`hello`) — `welcome/hello-app` — private — API `http://192.0.2.1:41003`
- **Tasks** (`tasks`) — `projects/tasks` — private — API `http://192.0.2.1:41207`

## Call an app

These apps are running services on this VM. Call one at its API address above —
nothing else is needed to reach it.

Read an app's `README.md` before calling its API or changing its code — it says
what the app is for and what its API accepts. If you change an app, update its
README in the same turn.

After changing an app's data, tell the user what changed and point them to the
app open beside the conversation.

## Move this session into an app

When building, editing, or demonstrating an app, move the session there as one of your first actions:

```bash
curl -sS -X POST \
  "$DUET_API_URL/v1/ws/sample/agent/sessions/$DUET_SESSION_ID/cwd" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"projects/example"}'
```

Use the app directory from the list above as `cwd`. The user sees the app immediately; your own working directory updates at your next turn.

Building and broken apps are safe to show: the gateway serves its own building page while the app is unavailable.

Prefer drive-absolute paths when showing files to the user.
