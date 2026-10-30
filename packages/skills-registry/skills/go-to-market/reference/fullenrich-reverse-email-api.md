# FullEnrich Reverse Email API

> **Result caveat:** Reverse lookup returns the **most recent** employment, not the most prominent. For example, `satya.nadella@microsoft.com` may resolve to a current board/advisor role instead of Microsoft CEO. If you need the role that matches the email domain, scan `profile.employment.all` and pick the entry whose `company.domain` matches the email host. Do not assume `employment.current` is the relevant role.
> Reference

## Start Reverse Email Lookup

Identify people from email addresses. Costs 1 credit per successfully identified email.

```
POST /contact/reverse/email/bulk
```

### Request

```bash
curl -X POST $DUET_API_URL/v1/services/fullenrich/api/v2/contact/reverse/email/bulk \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Reverse Lookup Batch 1",
    "webhook_url": "https://example.com/webhook",
    "webhook_events": {
      "contact_finished": "https://example.com/webhook/contact"
    },
    "data": [
      {
        "email": "john.snow@example.com",
        "custom": {"user_id": "12584"}
      }
    ]
  }'
```

**Parameters:**

| Field                             | Type   | Required | Description                                        |
| --------------------------------- | ------ | -------- | -------------------------------------------------- |
| `name`                            | string | Yes      | Readable name for the lookup batch                 |
| `webhook_url`                     | string | No       | URL for batch completion notification              |
| `webhook_events.contact_finished` | string | No       | URL for per-contact completion                     |
| `data`                            | array  | Yes      | Array of email objects                             |
| `data[].email`                    | string | Yes      | Email address to look up                           |
| `data[].custom`                   | object | No       | Custom metadata (max 10 keys, 100 chars per value) |

### Response

```json
{
  "enrichment_id": "2db5ea61-1752-42cf-8ea1-ab1da060cd0a"
}
```

## Get Reverse Lookup Results

```
GET /contact/reverse/email/bulk/{enrichment_id}
```

### Response

```json
{
  "id": "2db5ea61-1752-42cf-8ea1-ab1da060cd0a",
  "name": "Reverse Lookup Batch 1",
  "status": "FINISHED",
  "cost": {
    "credits": 1
  },
  "data": [
    {
      "input": {
        "email": "john.snow@example.com"
      },
      "custom": { "user_id": "12584" },
      "profile": {
        "id": "746e4816-19c8-54d8-b558-65a5a52cc85c",
        "full_name": "John Snow",
        "first_name": "John",
        "last_name": "Snow",
        "location": {
          "country": "United States",
          "country_code": "US",
          "city": "San Francisco",
          "region": "California"
        },
        "social_profiles": {
          "professional_network": {
            "url": "https://www.linkedin.com/in/johnsnow/",
            "handle": "johnsnow",
            "connection_count": 500
          }
        },
        "educations": [
          {
            "school_name": "Stanford University",
            "degree": "BS Computer Science",
            "start_at": "2015-09-01T00:00:00Z",
            "end_at": "2019-06-01T00:00:00Z"
          }
        ],
        "languages": [
          { "language": "English", "code": "EN", "proficiency": "Native or Bilingual" }
        ],
        "skills": ["JavaScript", "Python", "Project Management"],
        "employment": {
          "current": {
            "title": "Senior Software Engineer",
            "company": {
              "name": "Example Inc",
              "domain": "example.com"
            },
            "is_current": true,
            "start_at": "2022-03-15T00:00:00Z"
          },
          "all": [
            {
              "title": "Senior Software Engineer",
              "company": { "name": "Example Inc", "domain": "example.com" },
              "is_current": true,
              "start_at": "2022-03-15T00:00:00Z"
            },
            {
              "title": "Software Engineer",
              "company": { "name": "Previous Corp", "domain": "previous.com" },
              "is_current": false,
              "start_at": "2019-07-01T00:00:00Z",
              "end_at": "2022-03-01T00:00:00Z"
            }
          ]
        }
      }
    }
  ]
}
```

**Status values:** `CREATED`, `IN_PROGRESS`, `FINISHED`, `CANCELED`, `CREDITS_INSUFFICIENT`, `RATE_LIMIT`, `UNKNOWN`

See [./fullenrich-enrich-api.md](./fullenrich-enrich-api.md) for full status descriptions.
