# Watcher API Reference

Watchers monitor companies and people for changes and deliver notifications when events occur (new job postings, LinkedIn posts, funding rounds, etc.).

## Create a Watch

```
POST /watcher/watches
```

### Request

```bash
curl -s $DUET_API_URL/v1/services/crustdata/watcher/watches \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type": "company",
    "entity_identifier": "hubspot.com",
    "watch_type": "job_postings",
    "webhook_url": "https://your-endpoint.com/webhook",
    "frequency": "daily"
  }'
```

**Body Parameters:**

| Field               | Type   | Required | Description                            |
| ------------------- | ------ | -------- | -------------------------------------- |
| `entity_type`       | string | Yes      | `"company"` or `"person"`              |
| `entity_identifier` | string | Yes      | Domain, LinkedIn URL, or Crustdata ID  |
| `watch_type`        | string | Yes      | Type of event to watch (see below)     |
| `webhook_url`       | string | Yes      | URL to receive notifications           |
| `frequency`         | string | No       | Check frequency: `"daily"`, `"weekly"` |

**Watch types:**

| Watch Type         | Entity         | Description                   |
| ------------------ | -------------- | ----------------------------- |
| `job_postings`     | company        | New job listings posted       |
| `linkedin_posts`   | company/person | New LinkedIn posts            |
| `funding`          | company        | New funding rounds            |
| `headcount_change` | company        | Significant headcount changes |
| `news`             | company        | New news articles             |

### Response

```json
{
  "watch_id": "w_abc123",
  "entity_type": "company",
  "entity_identifier": "hubspot.com",
  "watch_type": "job_postings",
  "status": "active",
  "created_at": "2025-02-16T12:00:00Z"
}
```

## Update a Watch

Pause, resume, or delete a watch.

```
POST /watcher/watches/{watch_id}/update
```

### Request

```bash
curl -s $DUET_API_URL/v1/services/crustdata/watcher/watches/$WATCH_ID/update \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "paused"}'
```

**Body Parameters:**

| Field    | Type   | Description                            |
| -------- | ------ | -------------------------------------- |
| `status` | string | `"active"`, `"paused"`, or `"deleted"` |

### Response

```json
{
  "watch_id": "w_abc123",
  "status": "paused",
  "updated_at": "2025-02-16T14:00:00Z"
}
```

## Watcher Simulation

Test what a watcher would return without creating a persistent watch.

```
POST /watcher/simulation/watches
```

### Request

```bash
curl -s $DUET_API_URL/v1/services/crustdata/watcher/simulation/watches \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type": "company",
    "entity_identifier": "hubspot.com",
    "watch_type": "job_postings"
  }'
```

Returns a preview of what data the watch would capture, without creating a persistent watcher.
