# DataForSEO API

REST API for SEO keyword research, search volume data, keyword difficulty, SERP analysis, and domain keyword intelligence.

## Authentication

All requests use Duet's service-proxy bearer credential:

```
Authorization: Bearer $DUET_API_KEY
```

The proxy injects DataForSEO's upstream Basic credential at the vendor boundary.
Agents never need the vendor login or password.

## Base URL

```
$DUET_API_URL/v1/services/dataforseo
```

## Endpoint Quick Reference

### DataForSEO Labs (Keyword Research & Domain Intelligence)

| Endpoint                                               | Method | Purpose                                               | Cost                      |
| ------------------------------------------------------ | ------ | ----------------------------------------------------- | ------------------------- |
| `/dataforseo_labs/google/keyword_suggestions/live`     | POST   | Get keyword suggestions from a seed keyword           | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/related_keywords/live`        | POST   | Find semantically related keywords                    | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/keywords_for_site/live`       | POST   | Get keywords a domain ranks for or is relevant to     | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/ranked_keywords/live`         | POST   | Get all keywords a domain actually ranks for in SERPs | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/bulk_keyword_difficulty/live` | POST   | Get keyword difficulty scores for up to 1000 keywords | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/domain_intersection/live`     | POST   | Find keywords shared between two domains              | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/serp_competitors/live`        | POST   | Find competing domains for a keyword set              | $0.01/task + $0.0001/item |
| `/dataforseo_labs/google/keyword_ideas/live`           | POST   | Broader keyword ideas from seed (includes questions)  | $0.01/task + $0.0001/item |

### Keywords Data (Google Ads — Accurate Search Volume)

| Endpoint                                               | Method | Purpose                                         | Cost        |
| ------------------------------------------------------ | ------ | ----------------------------------------------- | ----------- |
| `/keywords_data/google_ads/search_volume/live`         | POST   | Get exact search volume for up to 1000 keywords | $0.075/task |
| `/keywords_data/google_ads/keywords_for_site/live`     | POST   | Keywords Google Ads suggests for a domain       | $0.075/task |
| `/keywords_data/google_ads/keywords_for_keywords/live` | POST   | Keyword ideas from seed keywords via Google Ads | $0.075/task |

### SERP API (Live Search Results)

| Endpoint                             | Method | Purpose                           | Cost        |
| ------------------------------------ | ------ | --------------------------------- | ----------- |
| `/serp/google/organic/live/regular`  | POST   | Get live Google SERP for a query  | $0.002/task |
| `/serp/google/organic/live/advanced` | POST   | Advanced SERP with extra features | $0.002/task |

## Request Format

All endpoints accept a JSON array of task objects in the POST body. Each task is an independent request.

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/keyword_suggestions/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "keyword": "project management software",
    "language_code": "en",
    "location_code": 2840,
    "limit": 50
  }]'
```

## Common Parameters

| Parameter                  | Type     | Description                                                           |
| -------------------------- | -------- | --------------------------------------------------------------------- |
| `keyword`                  | string   | Seed keyword (for keyword-based endpoints)                            |
| `target`                   | string   | Domain (for domain-based endpoints, e.g. `"example.com"`)             |
| `target1`, `target2`       | string   | Two domains (for intersection endpoint)                               |
| `keywords`                 | string[] | Array of keywords (for search_volume, bulk_keyword_difficulty)        |
| `language_code`            | string   | Language code, e.g. `"en"`                                            |
| `location_code`            | int      | Geo target. `2840` = United States. See locations endpoint for others |
| `limit`                    | int      | Max results to return (default varies by endpoint)                    |
| `offset`                   | int      | Skip N results for pagination                                         |
| `order_by`                 | string[] | Sort order, e.g. `["keyword_info.search_volume,desc"]`                |
| `filters`                  | array    | Filter results (see Filters section)                                  |
| `include_serp_info`        | bool     | Include SERP details per keyword (costs more)                         |
| `include_clickstream_data` | bool     | Include clickstream metrics (doubles cost)                            |

## Response Structure

```json
{
  "status_code": 20000,
  "tasks": [{
    "status_code": 20000,
    "cost": 0.0105,
    "result": [{
      "total_count": 1234,
      "items_count": 50,
      "items": [
        {
          "keyword_data": {
            "keyword": "...",
            "keyword_info": {
              "search_volume": 1200,
              "cpc": 4.50,
              "competition": 0.65,
              "competition_level": "HIGH",
              "monthly_searches": [{"year": 2025, "month": 12, "search_volume": 1400}, ...],
              "search_volume_trend": {"monthly": 10, "quarterly": 5, "yearly": 20}
            },
            "keyword_properties": {
              "keyword_difficulty": 45
            },
            "search_intent_info": {
              "main_intent": "commercial"
            }
          }
        }
      ]
    }]
  }]
}
```

### Key Fields in Keyword Results

| Field                                   | Description                                               |
| --------------------------------------- | --------------------------------------------------------- |
| `keyword_info.search_volume`            | Average monthly search volume                             |
| `keyword_info.cpc`                      | Cost per click ($)                                        |
| `keyword_info.competition`              | Google Ads competition (0-1)                              |
| `keyword_info.competition_level`        | LOW / MEDIUM / HIGH                                       |
| `keyword_info.monthly_searches`         | 12-month search volume history                            |
| `keyword_info.search_volume_trend`      | Monthly/quarterly/yearly % change                         |
| `keyword_properties.keyword_difficulty` | SEO difficulty score (0-100)                              |
| `search_intent_info.main_intent`        | informational / commercial / navigational / transactional |

## Filters

Filters use a nested array format: `[field, operator, value]`. Combine with `"and"` / `"or"`.

```json
"filters": [
  ["keyword_info.search_volume", ">=", 100],
  "and",
  ["keyword_info.search_volume", "<=", 10000],
  "and",
  ["keyword_properties.keyword_difficulty", "<=", 50]
]
```

Operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `not_contains`, `in`, `not_in`, `like`, `not_like`.

## Location Codes (Common)

| Code | Country        |
| ---- | -------------- |
| 2840 | United States  |
| 2826 | United Kingdom |
| 2124 | Canada         |
| 2036 | Australia      |
| 2276 | Germany        |
| 2250 | France         |

Full list: `GET /v3/dataforseo_labs/locations_and_languages`

## Pagination

For large result sets, use `offset` and `limit`. Some endpoints return an `offset_token` for cursor-based pagination.

```json
{
  "keyword": "seo tools",
  "limit": 100,
  "offset": 100,
  "language_code": "en",
  "location_code": 2840
}
```

## Rate Limits

- Max 2000 simultaneous requests
- No per-minute throttle — billed per request
- Pay-as-you-go, $50 minimum deposit
