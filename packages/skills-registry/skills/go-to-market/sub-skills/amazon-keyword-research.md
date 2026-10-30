# Amazon Keyword Research

Research Amazon keywords for product SEO — find high-volume search terms, analyze competitor products, and identify keyword opportunities on Amazon.

## Service proxy

Use the `$DUET_API_URL/v1/services/dataforseo` proxy with `$DUET_API_KEY`. The routes below are admitted by the catalog.

## Input

- **Seed keyword(s)** or **ASIN(s)**: Starting point for research
- **Competitor ASIN(s)** (optional): For keyword intersection analysis
- **Target market** (optional): Defaults to US (`location_code: 2840`, `language_code: "en"`)

## Instructions

### Step 1: Keyword Discovery

Based on input type, run the appropriate queries in parallel:

**If given seed keyword(s):**

1. **Related Keywords** — find semantically related Amazon search terms:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/related_keywords/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"keyword": "SEED", "language_code": "en", "location_code": 2840, "depth": 2, "limit": 100}]'
   ```

**If given an ASIN:**

1. **Ranked Keywords** — find what keywords the product ranks for:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/ranked_keywords/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"asin": "ASIN", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```

### Step 2: Get Search Volume

Collect candidate keywords and get Amazon search volume data:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/bulk_search_volume/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keywords": ["<KEYWORD_1>", "<KEYWORD_2>", "<KEYWORD_N>"], "language_code": "en", "location_code": 2840}]'
```

**Note:** Max 1000 keywords per request. Replace the `<KEYWORD_*>` placeholders with actual keywords collected from Step 1.

### Step 3: Competitor Analysis (if competitor ASIN provided)

**Find keyword overlaps between two products:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/product_keyword_intersections/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"asins": {"1": "COMPETITOR_ASIN", "2": "YOUR_ASIN"}, "language_code": "en", "location_code": 2840, "limit": 100}]'
```

**Find competing products:**

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/amazon/product_competitors/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"asin": "ASIN", "language_code": "en", "location_code": 2840, "limit": 20}]'
```

### Step 4: Prioritize & Deliver

Score keywords by Amazon search volume (higher = better), then group into clusters:

- **Brand keywords** — queries containing brand names
- **Product type keywords** — generic product category terms
- **Feature keywords** — specific features/attributes (e.g., "fast charging", "MagSafe compatible")
- **Problem keywords** — pain points (e.g., "charger for thick case")
- **Long-tail keywords** — 3+ word specific queries

Output as a chat message:

```
## Amazon Keyword Research: [Product/Topic]

### Key Findings
- Total keywords analyzed: X
- Total Amazon monthly search volume: X
- Top keyword: "X" (X searches/mo)

### Top Keywords by Search Volume

| Keyword | Amazon Volume | Depth |
|---------|-------------|-------|
| keyword 1 | 21,131 | 0 |
| keyword 2 | 3,104 | 1 |
| ... | | |

### Keyword Clusters

#### [Cluster Name] (X keywords, Xk total volume)
Top terms: `keyword a` (12k), `keyword b` (8k), `keyword c` (5k)
**Listing optimization angle:** [How to use in title/bullets/description]

### Competitor Keyword Gaps (if applicable)
Keywords competitor ranks for that target product doesn't.

### Listing Optimization Recommendations
1. **Title:** Include top 3-5 keywords naturally
2. **Bullet points:** Target feature/benefit keywords
3. **Backend search terms:** Use remaining long-tail keywords
```

## Output Format

**Output as a chat message, NOT a saved file.**

## Error Handling

**Empty results:** Try broader seed keywords or a different ASIN. Amazon keyword data is more limited than Google.
**No search volume:** Amazon search volume data may not be available for all keywords. Focus on the ones with data.
