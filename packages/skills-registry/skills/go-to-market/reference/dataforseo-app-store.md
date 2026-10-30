# DataForSEO App Store API

Endpoints for Apple App Store keyword research, app competitor analysis, and app search optimization (ASO).

## Authentication

```
Authorization: Bearer $DUET_API_KEY
```

## DataForSEO Labs — Apple App Store Endpoints

### Keywords For App

Find keywords an app ranks for in the App Store.

```
POST /v3/dataforseo_labs/apple/keywords_for_app/live
```

**Parameters:**

| Parameter       | Type   | Required | Description                                                |
| --------------- | ------ | -------- | ---------------------------------------------------------- |
| `app_id`        | string | Yes      | Apple App Store ID (numeric, e.g. `"803453959"` for Slack) |
| `language_code` | string | Yes      | e.g. `"en"`                                                |
| `location_code` | int    | Yes      | e.g. `2840` (US)                                           |
| `limit`         | int    | No       | Max results (default 100, max 1000)                        |
| `filters`       | array  | No       | Filter conditions                                          |
| `order_by`      | array  | No       | Sort rules                                                 |

**Response item fields:**

- `keyword` — the keyword
- `keyword_info.search_volume` — App Store search volume
- `keyword_info.competition` — competition score
- `ranked_serp_element.serp_item.rank_absolute` — app's rank for this keyword

**Cost:** $0.01/task + $0.0001/item

**Example:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/apple/keywords_for_app/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_id": "803453959", "language_code": "en", "location_code": 2840, "limit": 50}]'
```

---

### App Competitors

Find apps that compete for similar keywords in the App Store.

```
POST /v3/dataforseo_labs/apple/app_competitors/live
```

**Parameters:**

| Parameter       | Type   | Required | Description        |
| --------------- | ------ | -------- | ------------------ |
| `app_id`        | string | Yes      | Apple App Store ID |
| `language_code` | string | Yes      | e.g. `"en"`        |
| `location_code` | int    | Yes      | e.g. `2840` (US)   |
| `limit`         | int    | No       | Max results        |
| `filters`       | array  | No       | Filter conditions  |

**Response item fields:**

- `app_id` — competitor app ID
- `title` — app name
- `rating` — star rating
- `reviews_count` — number of reviews
- `intersections` — number of shared keywords
- `full_metrics` — keyword count, installs, etc.

**Cost:** $0.01/task + $0.0001/item

---

### App Intersection

Find keywords shared between two apps.

```
POST /v3/dataforseo_labs/apple/app_intersection/live
```

**Parameters:**

| Parameter       | Type   | Required | Description                          |
| --------------- | ------ | -------- | ------------------------------------ |
| `app_ids`       | object | Yes      | `{"1": "APP_ID_1", "2": "APP_ID_2"}` |
| `language_code` | string | Yes      | e.g. `"en"`                          |
| `location_code` | int    | Yes      | e.g. `2840` (US)                     |
| `limit`         | int    | No       | Max results                          |

**Cost:** $0.01/task + $0.0001/item

---

### Bulk App Metrics

Get aggregate metrics for multiple apps at once.

```
POST /v3/dataforseo_labs/apple/bulk_app_metrics/live
```

**Parameters:**

| Parameter       | Type     | Required | Description                    |
| --------------- | -------- | -------- | ------------------------------ |
| `app_ids`       | string[] | Yes      | Up to 1000 Apple App Store IDs |
| `language_code` | string   | Yes      | e.g. `"en"`                    |
| `location_code` | int      | Yes      | e.g. `2840` (US)               |

---

## App Data API — Apple

### App Search (Async)

Search the App Store for apps matching a keyword.

```
POST /v3/app_data/apple/app_searches/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description       |
| --------------- | ------ | -------- | ----------------- |
| `keyword`       | string | Yes      | Search query      |
| `language_code` | string | Yes      | e.g. `"en"`       |
| `location_code` | int    | Yes      | e.g. `2840` (US)  |
| `depth`         | int    | No       | Number of results |
| `priority`      | int    | No       | 1 or 2            |

**Retrieve results:**

```
GET /v3/app_data/apple/app_searches/task_get/{task_id}
```

---

### App Reviews (Async)

Get reviews for an Apple App Store app.

```
POST /v3/app_data/apple/app_reviews/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description                         |
| --------------- | ------ | -------- | ----------------------------------- |
| `app_id`        | string | Yes      | Apple App Store ID                  |
| `location_code` | int    | Yes      | e.g. `2840` (US)                    |
| `depth`         | int    | No       | Number of reviews                   |
| `sort_by`       | string | No       | `"most_relevant"`, `"newest"`, etc. |

---

### App List (Async)

Get top apps by collection (e.g., top free, top paid).

```
POST /v3/app_data/apple/app_list/task_post
```

**Parameters:**

| Parameter        | Type   | Required | Description                                       |
| ---------------- | ------ | -------- | ------------------------------------------------- |
| `app_collection` | string | Yes      | e.g. `"top_free"`, `"top_paid"`, `"top_grossing"` |
| `app_category`   | int    | No       | App Store category ID                             |
| `language_code`  | string | Yes      | e.g. `"en"`                                       |
| `location_code`  | int    | Yes      | e.g. `2840` (US)                                  |

---

## DataForSEO Labs — Google Play Endpoints

Google Play Labs endpoints live under `/v3/dataforseo_labs/google/` (not `/google_play/`). Same pricing as Apple Labs: $0.01/task + $0.0001/item.

### Keywords For App (Google Play)

Find keywords an app ranks for on Google Play.

```
POST /v3/dataforseo_labs/google/keywords_for_app/live
```

**Parameters:**

| Parameter       | Type   | Required | Description                                   |
| --------------- | ------ | -------- | --------------------------------------------- |
| `app_id`        | string | Yes      | Google Play package name (e.g. `"com.slack"`) |
| `language_code` | string | Yes      | e.g. `"en"`                                   |
| `location_code` | int    | Yes      | e.g. `2840` (US)                              |
| `limit`         | int    | No       | Max results (default 100, max 1000)           |
| `filters`       | array  | No       | Filter conditions                             |
| `order_by`      | array  | No       | Sort rules                                    |

**Response:** Same structure as Apple `keywords_for_app`.

---

### App Competitors (Google Play)

Find apps that compete for similar keywords on Google Play.

```
POST /v3/dataforseo_labs/google/app_competitors/live
```

**Parameters:** Same as Apple `app_competitors`, but `app_id` is a package name.

---

### App Intersection (Google Play)

Find keywords shared between two Google Play apps.

```
POST /v3/dataforseo_labs/google/app_intersection/live
```

**Parameters:**

| Parameter       | Type   | Required | Description                          |
| --------------- | ------ | -------- | ------------------------------------ |
| `app_ids`       | object | Yes      | `{"1": "com.app1", "2": "com.app2"}` |
| `language_code` | string | Yes      | e.g. `"en"`                          |
| `location_code` | int    | Yes      | e.g. `2840` (US)                     |
| `limit`         | int    | No       | Max results                          |

---

### Bulk App Metrics (Google Play)

Get aggregate metrics for multiple Google Play apps.

```
POST /v3/dataforseo_labs/google/bulk_app_metrics/live
```

**Parameters:**

| Parameter       | Type     | Required | Description                          |
| --------------- | -------- | -------- | ------------------------------------ |
| `app_ids`       | string[] | Yes      | Up to 1000 Google Play package names |
| `language_code` | string   | Yes      | e.g. `"en"`                          |
| `location_code` | int      | Yes      | e.g. `2840` (US)                     |

---

## App Data API — Google Play

### Google Play App Search (Async)

```
POST /v3/app_data/google/app_searches/task_post
```

Same parameters as Apple app search. Retrieve with `task_get`.

### Google Play App Reviews (Async)

```
POST /v3/app_data/google/app_reviews/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description                                   |
| --------------- | ------ | -------- | --------------------------------------------- |
| `app_id`        | string | Yes      | Google Play package name (e.g. `"com.slack"`) |
| `location_code` | int    | Yes      | e.g. `2840` (US)                              |
| `depth`         | int    | No       | Number of reviews                             |

### Google Play App List (Async)

```
POST /v3/app_data/google/app_list/task_post
```

Same parameters as Apple app list.

## Finding App IDs

- **Apple App Store:** The numeric ID in the App Store URL (e.g., `803453959` from `apps.apple.com/app/slack/id803453959`)
- **Google Play:** The package name in the Play Store URL (e.g., `com.slack` from `play.google.com/store/apps/details?id=com.slack`)
