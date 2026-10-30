# FullEnrich Enrich API Reference

## Start Bulk Enrichment

Enrich up to 100 contacts per request with work emails, personal emails, and phone numbers.

```
POST /contact/enrich/bulk
```

### Request

```bash
curl -X POST $DUET_API_URL/v1/services/fullenrich/api/v2/contact/enrich/bulk \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sales team enrichment",
    "webhook_url": "https://example.com/webhook",
    "webhook_events": {
      "contact_finished": "https://example.com/webhook/contact"
    },
    "data": [
      {
        "first_name": "John",
        "last_name": "Snow",
        "domain": "example.com",
        "company_name": "Example Inc",
        "linkedin_url": "https://www.linkedin.com/in/johnsnow/",
        "enrich_fields": ["contact.work_emails", "contact.phones"],
        "custom": {"user_id": "12584"}
      }
    ]
  }'
```

**Parameters:**

| Field                             | Type   | Required | Description                                |
| --------------------------------- | ------ | -------- | ------------------------------------------ |
| `name`                            | string | Yes      | Readable name for the enrichment batch     |
| `webhook_url`                     | string | No       | URL for batch completion notification      |
| `webhook_events.contact_finished` | string | No       | URL for per-contact completion (real-time) |
| `data`                            | array  | Yes      | Contact objects (max 100)                  |

**Contact object fields:**

| Field           | Type   | Required    | Description                                                      |
| --------------- | ------ | ----------- | ---------------------------------------------------------------- |
| `first_name`    | string | Conditional | Contact first name                                               |
| `last_name`     | string | Conditional | Contact last name                                                |
| `domain`        | string | Conditional | Company domain                                                   |
| `company_name`  | string | Conditional | Company name                                                     |
| `linkedin_url`  | string | Conditional | LinkedIn profile URL (standard or Sales Navigator)               |
| `enrich_fields` | array  | Yes         | Fields to enrich                                                 |
| `custom`        | object | No          | Custom metadata (max 10 keys, 100 chars per value, strings only) |

**Input requirements:** Provide either (`first_name` + `last_name` + `domain` or `company_name`) OR `linkedin_url`.

**`enrich_fields` values:**

| Value                     | Credits | Description              |
| ------------------------- | ------- | ------------------------ |
| `contact.work_emails`     | 1       | Work email addresses     |
| `contact.phones`          | 10      | Phone numbers            |
| `contact.personal_emails` | 3       | Personal email addresses |

### Response

```json
{
  "enrichment_id": "2db5ea61-1752-42cf-8ea1-ab1da060cd0a"
}
```

## Get Enrichment Results

Poll for results or use `forceResults` to get partial data while enrichment is in progress.

```
GET /contact/enrich/bulk/{enrichment_id}
```

**Query parameters:**

| Name           | Type    | Default | Description                                      |
| -------------- | ------- | ------- | ------------------------------------------------ |
| `forceResults` | boolean | false   | Return partial results even if still in progress |

### Response

```json
{
  "id": "2db5ea61-1752-42cf-8ea1-ab1da060cd0a",
  "name": "Sales team enrichment",
  "status": "FINISHED",
  "cost": {
    "credits": 12
  },
  "data": [
    {
      "input": {
        "first_name": "John",
        "last_name": "Snow",
        "full_name": "John Snow",
        "company_domain": "example.com",
        "company_name": "Example Inc",
        "professional_network_url": "https://www.linkedin.com/in/johnsnow/"
      },
      "custom": { "user_id": "12584" },
      "contact_info": {
        "most_probable_work_email": {
          "email": "john.snow@example.com",
          "status": "DELIVERABLE"
        },
        "most_probable_personal_email": {
          "email": "jsnow@gmail.com",
          "status": "HIGH_PROBABILITY"
        },
        "most_probable_phone": {
          "number": "+14155551234",
          "region": "US"
        },
        "work_emails": [{ "email": "john.snow@example.com", "status": "DELIVERABLE" }],
        "personal_emails": [{ "email": "jsnow@gmail.com", "status": "HIGH_PROBABILITY" }],
        "phones": [{ "number": "+14155551234", "region": "US" }]
      },
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
            "company": { "name": "Example Inc", "domain": "example.com" },
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

Profile data is only returned when a LinkedIn URL is provided as input.

**Enrichment status values:**

| Status                 | Description                       |
| ---------------------- | --------------------------------- |
| `CREATED`              | Enrichment queued but not started |
| `IN_PROGRESS`          | Contacts being enriched           |
| `FINISHED`             | All contacts processed            |
| `CANCELED`             | Enrichment was canceled           |
| `CREDITS_INSUFFICIENT` | Not enough credits                |
| `RATE_LIMIT`           | Rate limit hit during processing  |
| `UNKNOWN`              | Unknown state                     |

**Email status values:**

| Status             | Description                                         |
| ------------------ | --------------------------------------------------- |
| `DELIVERABLE`      | Email verified as deliverable                       |
| `HIGH_PROBABILITY` | Likely valid but not fully verified                 |
| `CATCH_ALL`        | Domain accepts all emails (can't verify individual) |
| `INVALID`          | Email is invalid                                    |
| `INVALID_DOMAIN`   | Domain does not exist                               |

## Webhooks

Two webhook patterns are available:

- **Batch completion** (`webhook_url`): Fires once after all contacts are processed
- **Per-contact** (`webhook_events.contact_finished`): Fires after each individual contact is enriched

Webhook failures retry every minute, up to 5 times (on non-2xx status).
