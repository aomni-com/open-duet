# App Store Keyword Research (ASO)

Research keywords for App Store Optimization — find what keywords an app ranks for, discover competitor apps, and identify keyword opportunities in the Apple App Store and Google Play.

## Service proxy

Use the `$DUET_API_URL/v1/services/dataforseo` proxy with `$DUET_API_KEY`. The routes below are admitted by the catalog.

## Input

- **App ID(s)**: Apple App Store numeric ID (e.g. `803453959`) or Google Play package name (e.g. `com.slack`)
- **Seed keyword(s)** (optional): For discovery when no app ID is known
- **Competitor app ID(s)** (optional): For keyword gap analysis
- **Store**: Apple App Store (default) or Google Play
- **Target market** (optional): Defaults to US (`location_code: 2840`, `language_code: "en"`)

## Instructions

### Step 1: Keyword Discovery

**If given an Apple App Store ID:**

1. **Keywords For App** — find what keywords the app ranks for:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/apple/keywords_for_app/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"app_id": "APP_ID", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```

**If given a seed keyword:**

1. **App Search** — find competing apps for the keyword:

   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/app_data/apple/app_searches/task_post" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"keyword": "KEYWORD", "language_code": "en", "location_code": 2840, "depth": 20, "priority": 2}]'
   ```

   Then retrieve results with `task_get`.

2. For each top competitor app found, run **Keywords For App** to expand keyword list.

**If given a Google Play package name:**

1. **Keywords For App** — find what keywords the app ranks for:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/keywords_for_app/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"app_id": "PACKAGE_NAME", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```

**Note:** Google Play Labs endpoints live under `/v3/dataforseo_labs/google/` (not `/google_play/`).

### Step 2: Competitor Analysis

**Find competitor apps (Apple):**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/apple/app_competitors/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_id": "APP_ID", "language_code": "en", "location_code": 2840, "limit": 20}]'
```

**Find competitor apps (Google Play):**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/app_competitors/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_id": "PACKAGE_NAME", "language_code": "en", "location_code": 2840, "limit": 20}]'
```

**Find keyword gaps between two apps (Apple):**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/apple/app_intersection/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_ids": {"1": "COMPETITOR_APP_ID", "2": "YOUR_APP_ID"}, "language_code": "en", "location_code": 2840, "limit": 100}]'
```

**Find keyword gaps between two apps (Google Play):**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/app_intersection/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_ids": {"1": "com.competitor", "2": "com.your.app"}, "language_code": "en", "location_code": 2840, "limit": 100}]'
```

### Step 3: Review Analysis (Optional)

Get competitor reviews to understand user sentiment and feature requests:

**Apple:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/app_data/apple/app_reviews/task_post" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_id": "APP_ID", "location_code": 2840, "depth": 50, "sort_by": "most_relevant"}]'
```

**Google Play:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/app_data/google/app_reviews/task_post" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"app_id": "com.package.name", "location_code": 2840, "depth": 50}]'
```

### Step 4: Deliver Results

Output as a chat message:

```
## App Store Keyword Research: [App Name]

### App Overview
- **Store:** Apple App Store / Google Play
- **App ID:** [ID]
- **Current ranking keywords:** X
- **Top competitors by keyword overlap:** [App 1], [App 2], [App 3]

### Top Keywords

| Keyword | Volume | Rank | Competition |
|---------|--------|------|-------------|
| keyword 1 | 5,000 | #3 | Medium |
| keyword 2 | 2,500 | #7 | Low |
| ... | | | |

### Competitor Comparison

| App | Shared Keywords | Unique Keywords | Rating | Reviews |
|-----|----------------|-----------------|--------|---------|
| Competitor 1 | X | Y | 4.5★ | 10k |
| ... | | | | |

### Keyword Gaps
Keywords competitors rank for that the target app doesn't:
| Keyword | Volume | Competitor Rank |
|---------|--------|----------------|
| ... | | |

### ASO Recommendations
1. **App title:** Include top 2-3 keywords
2. **Subtitle/short description:** Target feature keywords
3. **Keyword field (Apple):** Use remaining long-tail keywords, no duplicates from title
4. **Description:** Naturally incorporate keyword clusters
```

## Output Format

**Output as a chat message, NOT a saved file.**

## Notes

- **Both Apple App Store and Google Play** have Labs endpoints: `keywords_for_app`, `app_competitors`, `app_intersection`, `bulk_app_metrics`
- **Google Play Labs** endpoints live under `/v3/dataforseo_labs/google/` (not `/google_play/`)
- App Data API endpoints are **async** — submit via `task_post`, wait, then `task_get`
- DataForSEO Labs endpoints are **live** — results return immediately
- Labs endpoints are currently **US/English only**. App Data API supports more locations/languages.

## Error Handling

**"Invalid Path" on Google Play Labs:** Make sure you're using `/dataforseo_labs/google/` not `/dataforseo_labs/google_play/`.
**No keywords found for app:** The app may be too new or niche. Try searching by keyword first, then analyze top-ranking competitor apps.
