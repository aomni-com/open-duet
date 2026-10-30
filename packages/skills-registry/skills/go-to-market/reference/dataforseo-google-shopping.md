# DataForSEO Google Shopping API

Endpoints for Google Shopping product data and keyword research.

## Authentication

```
Authorization: Bearer $DUET_API_KEY
```

## Merchant API — Google Shopping

### Product Search (Async)

Search Google Shopping product listings. Uses task_post + task_get pattern.

```
POST /v3/merchant/google/products/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description                                     |
| --------------- | ------ | -------- | ----------------------------------------------- |
| `keyword`       | string | Yes      | Search query                                    |
| `language_code` | string | Yes      | e.g. `"en"`                                     |
| `location_code` | int    | Yes      | e.g. `2840` (US)                                |
| `depth`         | int    | No       | Number of results (default 10, max 100)         |
| `priority`      | int    | No       | 1 (standard, ~5min) or 2 (high priority, ~1min) |
| `tag`           | string | No       | Custom tag for tracking                         |

**Example:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/merchant/google/products/task_post" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keyword": "wireless charger", "language_code": "en", "location_code": 2840, "depth": 20, "priority": 2}]'
```

**Retrieve results:**

```bash
curl -s "$DUET_API_URL/v1/services/dataforseo/v3/merchant/google/products/task_get/TASK_ID" \
  -H "Authorization: Bearer $DUET_API_KEY"
```

**Response item fields:**

- `title` — product title
- `price` — current price
- `currency` — currency code
- `seller` — merchant name
- `url` — product URL
- `image_url` — product image
- `rating` — star rating
- `reviews_count` — number of reviews
- `product_id` — Google Shopping product ID
- `delivery_info` — shipping details

**Cost:** ~$0.002/product

---

### Sellers Search (Async)

Find all sellers for a specific Google Shopping product.

```
POST /v3/merchant/google/sellers/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description                |
| --------------- | ------ | -------- | -------------------------- |
| `product_id`    | string | Yes      | Google Shopping product ID |
| `language_code` | string | Yes      | e.g. `"en"`                |
| `location_code` | int    | Yes      | e.g. `2840` (US)           |

---

### Product Spec (Async)

Get detailed product specifications from Google Shopping.

```
POST /v3/merchant/google/product_spec/task_post
```

**Parameters:**

| Parameter       | Type   | Required | Description                |
| --------------- | ------ | -------- | -------------------------- |
| `product_id`    | string | Yes      | Google Shopping product ID |
| `language_code` | string | Yes      | e.g. `"en"`                |
| `location_code` | int    | Yes      | e.g. `2840` (US)           |

---

## SERP API — Google Shopping Results

Get Google Shopping SERP results directly (live, no async).

```
POST /v3/serp/google/shopping/live/regular
```

**Note:** This endpoint may not be available on all accounts. Use the Merchant API endpoints above as the primary approach.

## Workflow Pattern

Google Shopping endpoints use an **async task pattern**:

1. **POST** to `task_post` → get `task_id`
2. **Wait** 1-5 minutes (or use priority: 2 for ~1 min)
3. **GET** from `task_get/{task_id}` → get results

Poll with:

```bash
TASK_ID="your-task-id"
for i in $(seq 1 12); do
  RESULT=$(curl -s "$DUET_API_URL/v1/services/dataforseo/v3/merchant/google/products/task_get/$TASK_ID" \
    -H "Authorization: Bearer $DUET_API_KEY")
  STATUS=$(echo "$RESULT" | jq -r '.tasks[0].status_code')
  if [ "$STATUS" = "20000" ]; then
    echo "$RESULT" | jq '.tasks[0].result'
    break
  fi
  sleep 5
done
```
