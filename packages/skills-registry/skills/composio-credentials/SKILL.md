---
name: composio-credentials
target: both
description: Reference for calling connected integrations from deployed apps through Duet's Composio proxy, and for using integrations MCP tools directly from an agent.
---

# Composio Access

Agents should discover and call connected integrations directly with the
`integrations__*` MCP tools. Use the HTTP execution proxy when code running in a
deployed app needs to call an integration.

## Endpoint

```
POST $DUET_API_URL/v1/integrations/composio/execute/<TOOL_SLUG>
```

Authenticate with a durable Duet user key in the `Authorization: Bearer
<DUET_USER_KEY>` header. The proxy resolves the key's workspace and injects the
upstream Composio credentials server-side.

## Use in a Node.js App

```javascript
async function callComposioTool(toolSlug, args) {
  const resp = await fetch(
    `${process.env.DUET_API_URL}/v1/integrations/composio/execute/${toolSlug}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DUET_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ arguments: args }),
    },
  )
  if (!resp.ok) throw new Error(`Composio API error: ${resp.status}`)
  return resp.json()
}
```

## Deploy as a Duet App

Create a user key from [Duet API keys]({{APP_URL}}/settings/api-keys), selecting
the app's workspace. User keys are durable, scoped to one workspace, and do not
expire. Configure the deployed app with:

- `DUET_API_URL`: the Duet API origin
- `DUET_API_KEY`: the durable user key

Runner credentials are system-managed and must not be copied into a deployed
app. Never expose either key to browser code.

## Notes

- Agents use `integrations__*` MCP tools to discover available tool slugs and
  execute connected tools without handling credentials.
- Deployed apps pass only the tool slug and arguments; the proxy derives the
  workspace from the durable user key.
