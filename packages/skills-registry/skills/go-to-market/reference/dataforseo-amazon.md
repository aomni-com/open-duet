# DataForSEO Amazon API

Endpoints for Amazon keyword research, product competitor analysis, and search volume data.

## Authentication

Same as main DataForSEO API — HTTP Basic Auth:

```
Authorization: Bearer $DUET_API_KEY
```

## Base URL

```
$DUET_API_URL/v1/services/dataforseo
```

## DataForSEO Labs — Amazon Endpoints

### Related Keywords

Find keywords semantically related to a seed keyword on Amazon.

```
POST /dataforseo_labs/amazon/related_keywords/live
```

**Parameters:**

| Parameter       | Type   | Required | Description                                             |
| --------------- | ------ | -------- | ------------------------------------------------------- |
| `keyword`       | string | Yes      | Seed keyword                                            |
| `language_code` | string | Yes      | e.g. `"en"`                                             |
| `location_code` | int    | Yes      | e.g. `2840` (US)                                        |
| `depth`         | int    | No       | Search depth 0-4 (default 1). More depth = more results |
| `limit`         | int    | No       | Max results (default 100, max 1000)                     |
| `filters`       | array  | No       | Filter conditions                                       |
| `order_by`      | array  | No       | Sort rules                                              |

**Response item fields:**

- `keyword_data.keyword` — the related keyword
- `keyword_data.keyword_info.search_volume` — Amazon search volume
- `depth` — relation depth from seed
- `related_keywords` — array of further related terms

**Cost:** $0.01/task + $0.0001/item

**Example:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/related_keywords/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keyword": "wireless charger", "language_code": "en", "location_code": 2840, "limit": 50}]'
```

---

### Bulk Search Volume

Get Amazon search volume for up to 1000 keywords at once.

```
POST /dataforseo_labs/amazon/bulk_search_volume/live
```

**Parameters:**

| Parameter       | Type     | Required | Description         |
| --------------- | -------- | -------- | ------------------- |
| `keywords`      | string[] | Yes      | Up to 1000 keywords |
| `language_code` | string   | Yes      | e.g. `"en"`         |
| `location_code` | int      | Yes      | e.g. `2840` (US)    |

**Response item fields:**

- `keyword` — the keyword
- `search_volume` — Amazon monthly search volume

**Cost:** $0.01/task + $0.0001/item

**Example:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/bulk_search_volume/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keywords": ["wireless charger", "phone case", "bluetooth speaker"], "language_code": "en", "location_code": 2840}]'
```

---

### Product Competitors

Find competing products for a given ASIN on Amazon.

```
POST /dataforseo_labs/amazon/product_competitors/live
```

**Parameters:**

| Parameter       | Type   | Required | Description       |
| --------------- | ------ | -------- | ----------------- |
| `asin`          | string | Yes      | Amazon ASIN       |
| `language_code` | string | Yes      | e.g. `"en"`       |
| `location_code` | int    | Yes      | e.g. `2840` (US)  |
| `limit`         | int    | No       | Max results       |
| `filters`       | array  | No       | Filter conditions |

**Cost:** $0.01/task + $0.0001/item

---

### Product Keyword Intersections

Find keywords where two Amazon products both appear in search results.

```
POST /dataforseo_labs/amazon/product_keyword_intersections/live
```

**Parameters:**

| Parameter       | Type   | Required | Description                    |
| --------------- | ------ | -------- | ------------------------------ |
| `asins`         | object | Yes      | `{"1": "ASIN1", "2": "ASIN2"}` |
| `language_code` | string | Yes      | e.g. `"en"`                    |
| `location_code` | int    | Yes      | e.g. `2840` (US)               |
| `limit`         | int    | No       | Max results                    |

**Cost:** $0.01/task + $0.0001/item

---

### Ranked Keywords

Find keywords an Amazon product (ASIN) ranks for.

```
POST /dataforseo_labs/amazon/ranked_keywords/live
```

**Parameters:**

| Parameter       | Type   | Required | Description      |
| --------------- | ------ | -------- | ---------------- |
| `asin`          | string | Yes      | Amazon ASIN      |
| `language_code` | string | Yes      | e.g. `"en"`      |
| `location_code` | int    | Yes      | e.g. `2840` (US) |
| `limit`         | int    | No       | Max results      |

**Cost:** $0.01/task + $0.0001/item

---

## Merchant API — Amazon Product Search

Search Amazon product listings directly. Uses an async task_post + task_get pattern.

```
POST /merchant/amazon/products/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description                       |
| --------------- | ------ | -------- | --------------------------------- |
| `keyword`       | string | Yes      | Search query                      |
| `location_code` | int    | Yes      | e.g. `2840` (US)                  |
| `depth`         | int    | No       | Number of results (default 10)    |
| `priority`      | int    | No       | 1 (standard) or 2 (high priority) |

**Note:** The Merchant API does NOT accept `language_code` or `language_name` — language is derived from the location.

**Retrieve results:**

```
GET /merchant/amazon/products/task_get/{task_id}
```

**Response item fields:**

- `title` — product title
- `asin` — Amazon ASIN
- `price` — current price
- `rating` — star rating
- `reviews_count` — number of reviews
- `image_url` — product image
- `url` — product URL
- `is_amazon_choice` — badge indicator
- `is_best_seller` — badge indicator

**Cost:** ~$0.002/product (standard), ~$0.004 (priority)

## Location Codes (Amazon)

| Code | Market               |
| ---- | -------------------- |
| 2840 | Amazon.com (US)      |
| 2826 | Amazon.co.uk (UK)    |
| 2276 | Amazon.de (Germany)  |
| 2250 | Amazon.fr (France)   |
| 2380 | Amazon.it (Italy)    |
| 2724 | Amazon.es (Spain)    |
| 2392 | Amazon.co.jp (Japan) |
| 2124 | Amazon.ca (Canada)   |
