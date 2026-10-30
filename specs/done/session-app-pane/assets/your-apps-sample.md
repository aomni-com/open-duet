# Your apps

This is a snapshot of the apps available to this session when the session started.

- **Notes** (`notes`) — `projects/notes` — private
- **Team Dashboard** (`team-dashboard`) — `projects/team-dashboard` — public (https://team-dashboard--Example User.duet.app/)

## Move this session into an app

When building, editing, or demonstrating an app, move the session there as one of your first actions:

```bash
curl -sS -X POST \
  "$DUET_API_URL/v1/ws/Example User/agent/sessions/$DUET_SESSION_ID/cwd" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"cwd":"projects/example"}'
```

Use the app directory from the list above as `cwd`. The user sees the app immediately; your own working directory updates at your next turn.

Building and broken apps are safe to show: the gateway serves its own building page while the app is unavailable.

Prefer drive-absolute paths when showing files to the user.
