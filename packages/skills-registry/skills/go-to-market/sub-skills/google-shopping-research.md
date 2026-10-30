# Google Shopping Research

Research product positioning, pricing, and competitor landscape on Google Shopping.

## Service proxy

Use the `$DUET_API_URL/v1/services/dataforseo` proxy with `$DUET_API_KEY`. The routes below are admitted by the catalog.

## Input

- **Product keyword(s)**: Search terms to research
- **Target market** (optional): Defaults to US (`location_code: 2840`, `language_code: "en"`)

## Instructions

### Step 1: Product Search

Search Google Shopping for the target product keywords:

```bash
# Submit search task
TASK=$(curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/merchant/google/products/task_post" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keyword": "PRODUCT_KEYWORD", "language_code": "en", "location_code": 2840, "depth": 50, "priority": 2}]')

TASK_ID=$(echo "$TASK" | jq -r '.tasks[0].id')

# Poll for results (priority 2 = ~1 min)
for i in $(seq 1 12); do
  RESULT=$(curl -s "$DUET_API_URL/v1/services/dataforseo/v3/merchant/google/products/task_get/$TASK_ID" \
    -H "Authorization: Bearer $DUET_API_KEY")
  STATUS=$(echo "$RESULT" | jq -r '.tasks[0].status_code')
  if [ "$STATUS" = "20000" ]; then break; fi
  sleep 5
done
```

Run multiple keywords in parallel by submitting multiple task_post calls.

### Step 2: Analyze Results

From the product results, extract:

- **Price distribution** — min, max, median, average across listings
- **Top sellers** — which merchants appear most frequently
- **Product features** — common attributes mentioned in titles
- **Rating distribution** — average star ratings and review counts
- **Badges** — which products have sponsored, "best seller," or similar badges

### Step 3: Competitive Pricing Analysis

If a specific product_id is known, get seller comparison:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/merchant/google/sellers/task_post" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"product_id": "PRODUCT_ID", "language_code": "en", "location_code": 2840}]'
```

### Step 4: Deliver Results

Output as a chat message:

```
## Google Shopping Analysis: [Product Keyword]

### Market Overview
- Total products found: X
- Price range: $X — $Y (median: $Z)
- Average rating: X.X stars (X avg reviews)

### Top Products

| Product | Price | Rating | Reviews | Seller |
|---------|-------|--------|---------|--------|
| Product 1 | $XX.XX | 4.5★ | 1,234 | Amazon |
| ... | | | | |

### Pricing Insights
- **Budget segment** (under $X): X products, avg rating X
- **Mid-range** ($X—$Y): X products, avg rating X
- **Premium** (over $Y): X products, avg rating X

### Competitive Landscape
- **Top sellers:** [Seller 1] (X listings), [Seller 2] (X listings)
- **Common features in top-rated products:** [Feature 1], [Feature 2]
- **Gap opportunities:** [Underserved price point, missing features, etc.]

### Recommendations
1. **Pricing strategy:** [Based on market data]
2. **Feature differentiation:** [Based on competitor analysis]
3. **Listing optimization:** [Title patterns that appear in top results]
```

## Output Format

**Output as a chat message, NOT a saved file.**

## Error Handling

**Task still processing:** Google Shopping tasks may take 1-5 minutes. Use `priority: 2` for faster results. Poll every 5 seconds up to 60 seconds.
**No results:** Try broader keywords or check location_code is correct for the target marketplace.
