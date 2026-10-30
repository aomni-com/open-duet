# FullEnrich API

REST API for contact enrichment (work emails, personal emails, phone numbers), reverse email lookup, and people/company search.

## Authentication

Include the API key as a Bearer token on every request:

```
Authorization: Bearer $DUET_API_KEY
```

The key is available in the `DUET_API_KEY` environment variable.

## Base URL

```
$DUET_API_URL/v1/services/fullenrich
```

## Endpoint Quick Reference

| Endpoint                           | Method | Purpose                           | Credits                             |
| ---------------------------------- | ------ | --------------------------------- | ----------------------------------- |
| `/contact/enrich/bulk`             | POST   | Start bulk contact enrichment     | 1/email, 10/phone, 3/personal email |
| `/contact/enrich/bulk/{id}`        | GET    | Get enrichment results            | Free                                |
| `/contact/reverse/email/bulk`      | POST   | Start reverse email lookup        | 1/successful lookup                 |
| `/contact/reverse/email/bulk/{id}` | GET    | Get reverse lookup results        | Free                                |
| `/people/search`                   | POST   | Search for people with filters    | 0.25/result                         |
| `/company/search`                  | POST   | Search for companies with filters | 0.25/result                         |
| `/account/credits`                 | GET    | Check credit balance              | Free                                |

## Credit Costs

| Action                            | Credits |
| --------------------------------- | ------- |
| Work email enrichment             | 1       |
| Personal email enrichment         | 3       |
| Phone number enrichment           | 10      |
| Reverse email lookup (successful) | 1       |
| People search result              | 0.25    |
| Company search result             | 0.25    |

Previously enriched contacts are free to re-enrich within a 3-month data retention window.

## Rate Limits

- 60 API calls per minute (across all endpoints)
- Max 100 contacts per bulk enrichment request
- ~6,000 contacts per hour throughput

## Usage Pattern

All requests use `curl` with the Bearer auth header:

```bash
curl -s $DUET_API_URL/v1/services/fullenrich/api/v2/people/search \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"limit":1,"current_company_names":[{"value":"Anthropic"}]}'
```

## Common Workflows

### Enrich Contacts then Poll Results

1. Call `POST /contact/enrich/bulk` with contact data and desired `enrich_fields`
2. Poll `GET /contact/enrich/bulk/{enrichment_id}` until status is `FINISHED`
3. Alternatively, provide `webhook_url` to be notified on completion

### Reverse Lookup an Email

1. Call `POST /contact/reverse/email/bulk` with email addresses
2. Poll `GET /contact/reverse/email/bulk/{enrichment_id}` for profile data

### Search for People at a Company

1. Call `POST /people/search` with `current_company_names` or `current_company_domains` filters
2. Use `search_after` cursor for pagination beyond 10,000 results

## API Reference

- **Enrich API** — Bulk contact enrichment for emails and phone numbers. See [./fullenrich-enrich-api.md](./fullenrich-enrich-api.md).
- **Reverse Email API** — Identify a person from an email address. See [./fullenrich-reverse-email-api.md](./fullenrich-reverse-email-api.md).
- **Search API** — People and company search with filters. See [./fullenrich-search-api.md](./fullenrich-search-api.md).
