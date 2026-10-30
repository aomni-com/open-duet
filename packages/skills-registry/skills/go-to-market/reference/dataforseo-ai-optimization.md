# DataForSEO AI Optimization API

Endpoints for tracking AI search visibility, AI search volume, and Google AI Mode results.

## Authentication

```
Authorization: Bearer $DUET_API_KEY
```

## AI Keyword Data — Search Volume

Get AI-specific search volume for keywords (derived from People Also Ask statistics).

```
POST /v3/ai_optimization/ai_keyword_data/keywords_search_volume/live
```

**Parameters:**

| Parameter       | Type     | Required | Description                              |
| --------------- | -------- | -------- | ---------------------------------------- |
| `keywords`      | string[] | Yes      | Up to 1000 keywords (max 250 chars each) |
| `language_code` | string   | Yes      | e.g. `"en"`                              |
| `location_code` | int      | Yes      | e.g. `2840` (US)                         |

**Response item fields:**

- `keyword` — the keyword
- `ai_search_volume` — current AI search volume rate
- `ai_monthly_searches[]` — 12-month history (`year`, `month`, `ai_search_volume`)

**Example:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"language_code": "en", "location_code": 2840, "keywords": ["team messaging app", "slack alternative"]}]'
```

---

## Google AI Mode

Dedicated endpoint for Google's AI Mode search (separate from AI Overview in standard search).

```
POST /v3/serp/google/ai_mode/live/advanced
```

**Parameters:**

| Parameter       | Type   | Required | Description                         |
| --------------- | ------ | -------- | ----------------------------------- |
| `keyword`       | string | Yes      | Search query (max 700 chars)        |
| `location_code` | int    | Yes      | e.g. `2840` (US)                    |
| `language_code` | string | Yes      | e.g. `"en"`                         |
| `device`        | string | No       | `"desktop"` (default) or `"mobile"` |

**Response:** Returns `ai_overview` items with full AI-generated content, citations, and references — same structure as AI Overview in standard SERP but from Google's dedicated AI Mode.

---

## SERP API — AI Overview

See [dataforseo.md](dataforseo.md) for the standard SERP API. Use `load_async_ai_overview: true` to capture AI Overview data.

**Cost:** $0.004/request ($0.002 base + $0.002 for AI overview)

**AI Overview item types in response:**

- `ai_overview` — main AI overview block with `markdown`, `items[]`, `references[]`
- `ai_overview_element` — text sections with citations
- `ai_overview_video_element` — video citations
- `ai_overview_table_element` — table data
- `ai_overview_shopping_element` — product listings

---

## LLM Mentions API

Track keyword/brand/domain mentions across AI platforms (Google AI Overview, ChatGPT). Monitors how often domains, keywords, and brands appear in AI-generated answers — including which sources get cited, brand entity recognition, and mention frequency over time.

**Cost:** $0.10/request + $0.001/row

**Platforms:** `"google"` (AI Overview — default) or `"chat_gpt"` (ChatGPT — US/English only)

**Rate limits:** 2000 calls/min, max 30 simultaneous, 120s timeout per request

---

### LLM Mentions — Search

Find individual AI mentions of a domain or keyword with full question/answer context.

```
POST /v3/ai_optimization/llm_mentions/search/live
```

**Parameters:**

| Parameter            | Type   | Required | Description                                               |
| -------------------- | ------ | -------- | --------------------------------------------------------- |
| `target`             | array  | Yes      | Up to 10 target entities (domain or keyword objects)      |
| `platform`           | string | No       | `"google"` (default) or `"chat_gpt"`                      |
| `location_code`      | int    | No       | Default: `2840` (US)                                      |
| `language_code`      | string | No       | Default: `"en"`                                           |
| `filters`            | array  | No       | Up to 8 filters, e.g. `[["ai_search_volume", ">", 1000]]` |
| `order_by`           | array  | No       | Up to 3 sort rules, e.g. `["ai_search_volume,desc"]`      |
| `limit`              | int    | No       | Default: 100, max: 1000                                   |
| `offset`             | int    | No       | Max: 9000 (use `search_after_token` beyond)               |
| `search_after_token` | string | No       | Pagination token for offsets > 9000                       |

**Target — Domain entity:**

| Parameter            | Type   | Description                                              |
| -------------------- | ------ | -------------------------------------------------------- |
| `domain`             | string | Target domain (no `https://` or `www.`, max 63 chars)    |
| `search_filter`      | string | `"include"` (default) or `"exclude"`                     |
| `search_scope`       | array  | `["any"]` (default), `["sources"]`, `["search_results"]` |
| `include_subdomains` | bool   | Default: `false`                                         |

**Target — Keyword entity:**

| Parameter       | Type   | Description                                                                          |
| --------------- | ------ | ------------------------------------------------------------------------------------ |
| `keyword`       | string | Target keyword (max 250 chars)                                                       |
| `search_filter` | string | `"include"` (default) or `"exclude"`                                                 |
| `search_scope`  | array  | `["any"]`, `["question"]`, `["answer"]`, `["brand_entities"]`, `["fan_out_queries"]` |
| `match_type`    | string | `"word_match"` (default) or `"partial_match"`                                        |

**Response item fields:**

- `question` — the AI-generated question
- `answer` — markdown-formatted AI response
- `sources[]` — cited sources (`domain`, `url`, `title`, `snippet`, `position`)
- `search_results[]` — web search results retrieved for the AI response
- `ai_search_volume` — current AI search volume rate
- `ai_monthly_searches[]` — 12-month history (`year`, `month`, `ai_search_volume`)
- `brand_entities[]` — brand mentions in the response
- `fan_out_queries[]` — related follow-up queries
- `first_response_at`, `last_response_at` — timestamps

**Example — find where a domain is cited:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/search/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"domain": "duet.so", "search_scope": ["sources"]}],
    "platform": "google",
    "location_code": 2840,
    "language_code": "en",
    "order_by": ["ai_search_volume,desc"],
    "limit": 20
  }]'
```

**Example — find AI mentions of a keyword with high volume:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/search/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"keyword": "team messaging app", "search_scope": ["answer"]}],
    "platform": "google",
    "filters": [["ai_search_volume", ">", 100]],
    "order_by": ["ai_search_volume,desc"],
    "limit": 50
  }]'
```

**Example — exclude own domain and find competitor mentions:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/search/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [
      {"keyword": "best ai chat app", "search_scope": ["answer"]},
      {"domain": "duet.so", "search_filter": "exclude"}
    ],
    "platform": "google",
    "order_by": ["ai_search_volume,desc"],
    "limit": 20
  }]'
```

---

### LLM Mentions — Aggregated Metrics

Get rolled-up mention counts, AI search volume, and impressions for a domain or keyword — broken down by location, language, platform, and source domains. No individual mention items returned.

```
POST /v3/ai_optimization/llm_mentions/aggregated_metrics/live
```

**Parameters:** Same `target`, `platform`, `location_code`, `language_code`, `initial_dataset_filters` as Search. Plus:

| Parameter             | Type | Description                                         |
| --------------------- | ---- | --------------------------------------------------- |
| `internal_list_limit` | int  | Max elements in breakout arrays (1-20, default: 10) |

**Response fields (in `result[].total`):**

- `location[]` — mentions/volume/impressions per location
- `language[]` — per language
- `platform[]` — per platform
- `sources_domain[]` — top source domains cited (with mentions, volume, impressions)
- `search_results_domain[]` — top domains in search results
- `brand_entities_title[]` — top brand entities mentioned
- `brand_entities_category[]` — top brand entity categories

Each breakout element: `{ type: "group_element", key: "...", mentions: N, ai_search_volume: N, impressions: N }`

**Example — get aggregated visibility metrics for a domain:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/aggregated_metrics/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"domain": "duet.so", "search_scope": ["sources"], "include_subdomains": true}],
    "platform": "google",
    "location_code": 2840,
    "internal_list_limit": 10
  }]'
```

---

### LLM Mentions — Top Domains

Aggregated metrics grouped by most frequently mentioned domains. Shows which domains dominate AI mentions for your target keywords.

```
POST /v3/ai_optimization/llm_mentions/top_domains/live
```

**Parameters:** Same as Aggregated Metrics, plus:

| Parameter             | Type   | Description                                        |
| --------------------- | ------ | -------------------------------------------------- |
| `links_scope`         | string | `"sources"` (default) or `"search_results"`        |
| `items_list_limit`    | int    | Max domain results (1-10, default: 5)              |
| `internal_list_limit` | int    | Max elements in breakout arrays (1-10, default: 5) |

**Response:** `result[].total` has overall metrics, `result[].items[]` has per-domain breakdowns keyed by domain name.

**Example — find top domains cited for a keyword:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/top_domains/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"keyword": "best team chat app", "search_scope": ["answer"]}],
    "platform": "google",
    "links_scope": "sources",
    "items_list_limit": 10,
    "internal_list_limit": 5
  }]'
```

---

### LLM Mentions — Top Pages

Aggregated metrics grouped by most frequently mentioned pages (URLs). Shows which specific pages get cited most in AI responses.

```
POST /v3/ai_optimization/llm_mentions/top_pages/live
```

**Parameters:** Same as Top Domains (including `links_scope`, `items_list_limit`, `internal_list_limit`).

**Response:** Same structure as Top Domains but `items[].key` is a full page URL instead of a domain.

**Example — find top cited pages for a keyword:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/top_pages/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"keyword": "slack alternative with ai", "search_scope": ["answer"]}],
    "platform": "google",
    "links_scope": "sources",
    "items_list_limit": 10
  }]'
```

---

### LLM Mentions — Cross Aggregated Metrics

Compare mention metrics across multiple target groups in a single request. Each group gets an `aggregation_key` label for easy comparison.

```
POST /v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live
```

**Key difference:** Uses `targets` (plural) instead of `target`. Each entry has an `aggregation_key` and its own `target` array.

| Parameter                 | Type   | Required | Description                                                  |
| ------------------------- | ------ | -------- | ------------------------------------------------------------ |
| `targets`                 | array  | Yes      | 2-10 target groups, each with `aggregation_key` + `target[]` |
| `platform`                | string | No       | `"google"` (default) or `"chat_gpt"`                         |
| `initial_dataset_filters` | array  | No       | Up to 8 filters                                              |
| `internal_list_limit`     | int    | No       | 1-10, default: 5                                             |

**Example — compare competitors' AI visibility:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "platform": "google",
    "location_code": 2840,
    "targets": [
      {
        "aggregation_key": "duet",
        "target": [{"domain": "duet.so", "search_scope": ["sources"], "include_subdomains": true}]
      },
      {
        "aggregation_key": "slack",
        "target": [{"domain": "slack.com", "search_scope": ["sources"]}]
      },
      {
        "aggregation_key": "teams",
        "target": [{"domain": "microsoft.com", "search_scope": ["sources"]}]
      }
    ],
    "initial_dataset_filters": [["ai_search_volume", ">", 10]],
    "internal_list_limit": 5
  }]'
```

**Response:** `result[].total` has combined metrics, `result[].items[]` has per-group metrics keyed by `aggregation_key`.

---

### Filter Operators (All LLM Mentions Endpoints)

Operators: `=`, `<>`, `in`, `not_in`, `like`, `not_like`, `ilike`, `not_ilike`, `match`, `not_match`

**Filterable fields** (Search endpoint `filters`, others use `initial_dataset_filters`):

- `ai_search_volume` — filter by AI search volume
- Other fields vary by endpoint — check response item fields

```json
"filters": [["ai_search_volume", ">", 1000]]
"initial_dataset_filters": [["ai_search_volume", ">", 10]]
```

---

## Supported Locations & Languages

AI Keyword Data and SERP AI endpoints support multiple locations. Check available options:

```
GET /v3/ai_optimization/ai_keyword_data/locations_and_languages
```
