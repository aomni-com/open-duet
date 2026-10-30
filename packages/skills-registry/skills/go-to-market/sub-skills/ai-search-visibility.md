# AI Search Visibility Analysis

Analyze how a domain or topic appears in Google's AI Overview, Google AI Mode, ChatGPT, and across AI search platforms. Use DataForSEO's SERP API, AI Keyword Data API, AI Mode endpoint, and **LLM Mentions API** to track citations, measure AI search volume, monitor brand mentions across LLMs, and identify optimization opportunities.

## Service proxy

Use the `$DUET_API_URL/v1/services/dataforseo` proxy with `$DUET_API_KEY`. The routes below are admitted by the catalog.

## Input

- **Target keyword(s)**: Queries to analyze for AI Overview presence
- **Target domain** (optional): Domain to track citations for
- **Competitor domain(s)** (optional): For comparative analysis

## Instructions

### Step 1: Identify Target Keywords & Get AI Search Volume

If given a domain, first find its top keywords using the SEO Keyword Research sub-skill, then filter to informational/commercial queries most likely to trigger AI Overviews.

If given keywords directly, first get their **AI search volume** to understand how often they're queried via AI:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"language_code": "en", "location_code": 2840, "keywords": ["KEYWORD_1", "KEYWORD_2", "KEYWORD_N"]}]'
```

**Response fields:**

- `ai_search_volume` — current AI search volume rate
- `ai_monthly_searches[]` — 12-month history (`year`, `month`, `ai_search_volume`)

This helps prioritize which keywords matter most in AI search. Rising AI volume = growing opportunity.

**Keywords most likely to have AI Overviews:**

- Question queries ("what is...", "how to...", "best...")
- Comparison queries ("X vs Y", "best X for Y")
- Informational/educational queries
- "Near me" and local queries

### Step 2: Fetch AI Overview Data

For each keyword, use the SERP Advanced endpoint with `load_async_ai_overview: true`:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/serp/google/organic/live/advanced" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "keyword": "QUERY",
    "language_code": "en",
    "location_code": 2840,
    "depth": 10,
    "load_async_ai_overview": true
  }]'
```

**Cost:** one metered request per call, whatever the page size. Read the
current service metadata with `duet services show dataforseo`; bound the NUMBER
of calls rather than assuming a fixed price.

**Key response fields in AI Overview items:**

- `type: "ai_overview"` — the AI overview block
- `asynchronous_ai_overview` — whether AI overview was loaded async
- `markdown` — full AI overview text with citation links
- `items[]` — array of AI overview elements, each containing:
  - `title` — section title
  - `text` — plain text content
  - `markdown` — formatted content with citations
  - `references[]` — cited sources with:
    - `source` — publisher name
    - `domain` — cited domain
    - `url` — cited URL
    - `title` — cited page title
    - `text` — snippet shown

### Step 2b: Google AI Mode (Optional)

For deeper AI search analysis, also query Google's AI Mode endpoint:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/serp/google/ai_mode/live/advanced" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keyword": "QUERY", "language_code": "en", "location_code": 2840}]'
```

Returns a full AI-generated response with citations — useful for seeing how Google's AI Mode (separate from AI Overview) answers the query and which sources it cites.

### Step 2c: LLM Mentions — Domain Visibility (If domain provided)

Use the LLM Mentions Search endpoint to find all AI mentions where the target domain is cited as a source. This gives a comprehensive view of which AI-generated questions/answers reference the domain.

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/search/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"domain": "TARGET_DOMAIN", "search_scope": ["sources"], "include_subdomains": true}],
    "platform": "google",
    "location_code": 2840,
    "language_code": "en",
    "order_by": ["ai_search_volume,desc"],
    "limit": 50
  }]'
```

This returns each AI Q&A where the domain appears, including:

- The question the AI answered
- The full AI answer (markdown)
- Which sources were cited (and the domain's position among them)
- AI search volume and monthly trends
- Brand entities and fan-out queries

### Step 2d: LLM Mentions — Aggregated Metrics

Get rolled-up mention counts, total AI search volume, and impressions for the target domain:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/aggregated_metrics/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"domain": "TARGET_DOMAIN", "search_scope": ["sources"], "include_subdomains": true}],
    "platform": "google",
    "location_code": 2840,
    "internal_list_limit": 10
  }]'
```

This gives headline numbers: total mentions, total AI search volume exposure, and impressions — plus breakdowns by source domain, brand entities, and categories.

### Step 2e: LLM Mentions — Top Competing Domains

Find which domains dominate AI mentions for the target keywords:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/top_domains/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "target": [{"keyword": "KEYWORD", "search_scope": ["answer"]}],
    "platform": "google",
    "links_scope": "sources",
    "items_list_limit": 10,
    "internal_list_limit": 5
  }]'
```

Run this for each high-value keyword to see which competitors are most frequently cited in AI responses.

### Step 2f: LLM Mentions — Competitor Comparison (If competitors provided)

Compare your domain against competitors in a single API call:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "platform": "google",
    "location_code": 2840,
    "targets": [
      {
        "aggregation_key": "TARGET_LABEL",
        "target": [{"domain": "TARGET_DOMAIN", "search_scope": ["sources"], "include_subdomains": true}]
      },
      {
        "aggregation_key": "COMPETITOR_1_LABEL",
        "target": [{"domain": "COMPETITOR_1_DOMAIN", "search_scope": ["sources"]}]
      },
      {
        "aggregation_key": "COMPETITOR_2_LABEL",
        "target": [{"domain": "COMPETITOR_2_DOMAIN", "search_scope": ["sources"]}]
      }
    ],
    "initial_dataset_filters": [["ai_search_volume", ">", 10]],
    "internal_list_limit": 5
  }]'
```

This returns side-by-side mention counts, AI search volume, and impressions for each domain — ideal for competitive AI visibility benchmarking.

### Step 3: Analyze Citations

For each AI Overview result, extract:

1. **Which domains are cited** — count citations per domain
2. **What content types get cited** — listicles, reviews, how-tos, comparison pages
3. **Citation position** — early vs late in the overview
4. **Target domain presence** — is the target domain cited? If so, for which queries?

### Step 4: Organic + AI Overview Cross-Reference

Also extract the regular organic results from the same SERP to compare:

- Does ranking #1 organically guarantee an AI citation? (Often no)
- Which organic positions tend to get cited in the AI Overview?
- Are there domains cited in AI but not in organic top 10?

### Step 5: Deliver Results

Output as a chat message:

```
## AI Search Visibility: [Domain/Topic]

### AI Overview Presence
- Queries analyzed: X
- Queries with AI Overviews: X (X%)
- Queries where [domain] is cited: X (X%)
- Total citations across all queries: X

### AI Search Volume

| Query | AI Volume | Trend (3mo) | AI Overview? |
|-------|----------|-------------|-------------|
| "best ai chat app" | 153 | ↑ trending up | ✅ |
| "slack alternative" | 89 | → stable | ✅ |
| ... | | | |

### Citation Analysis

| Query | AI Overview? | [Domain] Cited? | Cited Sources |
|-------|-------------|-----------------|---------------|
| "best team chat app" | ✅ | ❌ | zapier.com, zdnet.com, pumble.com |
| "how to improve team..." | ✅ | ✅ (#2) | [domain], hubspot.com |
| ... | | | |

### Top Cited Domains (Across All Queries)

| Domain | Citations | % of Total |
|--------|----------|------------|
| zapier.com | 5 | 25% |
| zdnet.com | 3 | 15% |
| ... | | |

### Content Patterns in Cited Pages
- **Listicles/roundups:** X citations (X%)
- **How-to guides:** X citations (X%)
- **Comparison pages:** X citations (X%)
- **Product pages:** X citations (X%)

### LLM Mentions Overview

| Metric | Value |
|--------|-------|
| Total AI mentions (as source) | X |
| Total AI search volume exposure | X |
| Total AI impressions | X |
| Platform | Google AI Overview |

### Top Domains in AI Mentions (for target keywords)

| Domain | Mentions | AI Search Volume | Impressions |
|--------|----------|-----------------|-------------|
| zapier.com | 45 | 12,340 | 1,200,000 |
| ... | | | |

### Competitor AI Visibility Comparison

| Domain | Mentions | AI Search Volume | Impressions |
|--------|----------|-----------------|-------------|
| [target] | X | X | X |
| [competitor 1] | X | X | X |
| [competitor 2] | X | X | X |

### Top Pages Cited in AI Responses

| Page URL | Mentions | AI Search Volume |
|----------|----------|-----------------|
| https://example.com/best-tools | 12 | 5,400 |
| ... | | |

### AI Visibility Recommendations
1. **Content gap:** Create [content type] targeting [query] — currently no [domain] citation
2. **Strengthen existing:** [URL] ranks #X organically for [query] but isn't cited — improve [specific aspect]
3. **New opportunity:** [Query] triggers AI Overview but [domain] has no relevant content
4. **Structural improvements:** AI Overviews tend to cite pages with [specific patterns]
```

## Output Format

**Output as a chat message, NOT a saved file.**

**Important:** Run queries sequentially or in small batches to avoid hitting rate limits. Every SERP + AI Overview request is one billed call, so the query list is the cost — bound it before running, and say how it is bounded.

## Error Handling

**No AI Overview returned:** Not all queries trigger AI Overviews. Focus on question-format and informational queries.
**`asynchronous_ai_overview: true`:** The AI overview was loaded asynchronously — data should still be complete.
**AI Overview items empty:** Google may not show an AI Overview for that query in the target location. Try different phrasing.
