# FullEnrich Reverse Email Lookup Reference

## Flow

Async two-step: start lookup → poll for results.

## Authentication

```
Authorization: Bearer $DUET_API_KEY
```

## Step 1: Start Reverse Lookup

```
POST $DUET_API_URL/v1/services/fullenrich/api/v2/contact/reverse/email/bulk
```

### Request

```json
{
  "name": "reverse-lookup",
  "data": [{ "email": "person@example.com" }]
}
```

### Response

```json
{ "enrichment_id": "uuid-string" }
```

## Step 2: Poll for Results

```
GET $DUET_API_URL/v1/services/fullenrich/api/v2/contact/reverse/email/bulk/{enrichment_id}
```

### Response (FINISHED)

```json
{
  "id": "uuid",
  "status": "FINISHED",
  "cost": { "credits": 1 },
  "data": [
    {
      "input": { "email": "person@example.com" },
      "profile": {
        "full_name": "Name",
        "first_name": "First",
        "last_name": "Last",
        "location": { "country": "US", "city": "SF", "region": "CA" },
        "social_profiles": {
          "professional_network": {
            "url": "https://www.linkedin.com/in/handle/",
            "handle": "handle",
            "connection_count": 500
          }
        },
        "skills": ["Skill 1"],
        "employment": {
          "current": {
            "title": "Title",
            "company": { "name": "Co", "domain": "co.com" },
            "start_at": "2022-01-01T00:00:00Z"
          }
        }
      }
    }
  ]
}
```

## Status Values

`CREATED` → `IN_PROGRESS` → `FINISHED`

Also: `CANCELED`, `CREDITS_INSUFFICIENT`, `RATE_LIMIT`, `UNKNOWN`

## Cost

1 credit per successful lookup.

## Rate Limit

60 API calls/minute across all endpoints.

## Polling Strategy

Poll every 5 seconds, timeout after 60 seconds.
