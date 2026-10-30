---
name: webhook-collector
target: both
description: 'Create webhook endpoints, send test payloads, and inspect captured events using webhookcollector.dev. Use for both temporary testing and permanent webhook infrastructure. Endpoints are persistent — only event data expires after 24hrs, so pair with a cron to drain events for long-lived use. Use when the user asks to test webhooks, receive callbacks, capture HTTP requests, debug webhook integrations, create a webhook listener, or inspect incoming payloads. No authentication or signup required.'
---

# Webhook Collector

Create, test, and inspect webhooks via [webhookcollector.dev](https://webhookcollector.dev). Endpoints are **permanent** — only event data in the queue has a 24hr lifetime. 64KB body limit per event. No auth required.

Works for both quick testing and permanent webhook infrastructure. For long-lived endpoints, set up a cron to drain events within 24hrs.

## API Base

```
https://webhookcollector.dev/api
```

## Create an Endpoint

```bash
curl -s -X POST https://webhookcollector.dev/api/v1/endpoints | jq .
```

Returns:

```json
{
  "ingestUrl": "https://webhookcollector.dev/api/ingest/ep_XXXXX",
  "eventsUrl": "https://webhookcollector.dev/api/v1/endpoints/ep_XXXXX/events"
}
```

- `ingestUrl` — point your service here to capture webhooks
- `eventsUrl` — fetch captured events from here
- The endpoint ID is the last segment of `ingestUrl` (e.g. `ep_XXXXX`)

## Send a Test Webhook

```bash
curl -s -X POST "https://webhookcollector.dev/api/ingest/ep_XXXXX" \
  -H "Content-Type: application/json" \
  -d '{"event": "user.created", "data": {"id": 42}}' | jq .
```

Any HTTP method works (GET, POST, PUT, PATCH, DELETE). The full request is captured including method, headers, body, query params, and source IP.

## List Captured Events

```bash
curl -s "https://webhookcollector.dev/api/v1/endpoints/ep_XXXXX/events?limit=20" | jq .
```

- `limit` — max events to return (default: 20)
- `cursor` — pagination cursor from `nextCursor` in previous response
- Check `hasMore` to know if more pages exist

## Event Structure

Each event contains:

| Field              | Description                                 |
| ------------------ | ------------------------------------------- |
| `eventId`          | Unique event identifier                     |
| `method`           | HTTP method (GET, POST, etc.)               |
| `path`             | Request path                                |
| `query`            | Query parameters object                     |
| `headers`          | All request headers                         |
| `body.contentType` | Content-Type of the request                 |
| `body.encoding`    | `utf8` or `base64`                          |
| `body.data`        | The request body content                    |
| `body.truncated`   | Whether the body was truncated (64KB limit) |
| `sourceIp`         | Sender's IP address                         |
| `receivedAt`       | ISO timestamp                               |

## Typical Workflow — Quick Testing

1. **Create** an endpoint
2. Give the user the `ingestUrl` to point their service at
3. **Send** test payloads or wait for real webhooks to arrive
4. **List events** to see what was captured
5. Parse and inspect individual events for debugging

## Typical Workflow — Permanent Webhook Infra

1. **Create** an endpoint once — save the endpoint ID
2. Point the external service at the `ingestUrl`
3. Set up a **cron job** (e.g. every few hours) to poll events and process them
4. Events must be drained within 24hrs or they expire from the queue

Example cron approach:

```bash
# Fetch latest events and process them
curl -s "https://webhookcollector.dev/api/v1/endpoints/ep_XXXXX/events?limit=100" | jq '.events[]'
```

## Notes

- **Endpoints are permanent** — they don't expire
- **Event data expires after 24 hours** — drain the queue regularly for production use
- Body limit is **64KB** per event — larger payloads get truncated
- Endpoints are public but use unguessable IDs — no auth needed
- Works for both quick debugging and long-lived webhook infrastructure
