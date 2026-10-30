# SEO Keyword Research

Research keywords for SEO strategy — find high-opportunity keywords, analyze competitors, assess difficulty, and deliver actionable content recommendations.

## Service proxy

Use the `$DUET_API_URL/v1/services/dataforseo` proxy with `$DUET_API_KEY`. The routes below are admitted by the catalog.

## Input

- **Seed keyword(s) or domain**: Starting point for research
- **Competitor domain(s)** (optional): For gap analysis
- **Target market** (optional): Defaults to US English (`location_code: 2840`, `language_code: "en"`)

## Instructions

### Step 1: Seed Expansion

Based on input type, run the appropriate queries in parallel:

**If given a domain:**

1. **Keywords For Site** — find keywords the domain is relevant to:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/keywords_for_site/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"target": "DOMAIN", "language_code": "en", "location_code": 2840, "limit": 100, "order_by": ["keyword_info.search_volume,desc"]}]'
   ```
2. **Ranked Keywords** — find keywords the domain actually ranks for:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/ranked_keywords/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"target": "DOMAIN", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```

**If given seed keyword(s):**

1. **Keyword Suggestions** — direct variations:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/keyword_suggestions/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"keyword": "SEED", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```
2. **Related Keywords** — semantically related terms:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/related_keywords/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"keyword": "SEED", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```
3. **Keyword Ideas** — broader expansion including questions:
   ```bash
   curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/keyword_ideas/live" \
     -H "Authorization: Bearer $DUET_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"keyword": "SEED", "language_code": "en", "location_code": 2840, "limit": 100}]'
   ```

### Step 2: Get Accurate Search Volume

Collect the top candidate keywords (up to 1000) from Step 1 and get Google Ads search volume data:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/keywords_data/google_ads/search_volume/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keywords": ["<KEYWORD_1>", "<KEYWORD_2>", "<KEYWORD_N>"], "language_code": "en", "location_code": 2840}]'
```

**Note:** Max 1000 keywords per task. Cost is $0.075/task regardless of count. Replace the `<KEYWORD_*>` placeholders with the actual keywords collected from Step 1.

### Step 3: Assess Keyword Difficulty

Get difficulty scores for the most promising keywords:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/bulk_keyword_difficulty/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"keywords": ["<KEYWORD_1>", "<KEYWORD_2>", "<KEYWORD_N>"], "language_code": "en", "location_code": 2840}]'
```

Replace the `<KEYWORD_*>` placeholders with the most promising keywords from earlier steps.

### Step 4: Competitor Gap Analysis (if competitor provided)

Find keywords the competitor ranks for that the target doesn't:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/domain_intersection/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"target1": "COMPETITOR", "target2": "OUR_DOMAIN", "language_code": "en", "location_code": 2840, "limit": 100, "intersections": {"1": true, "2": false}}]'
```

Setting `"intersections": {"1": true, "2": false}` returns keywords where target1 ranks but target2 doesn't — i.e., keyword gaps.

### Step 5: AI Search Volume (Optional Enrichment)

For keywords likely to appear in AI search (questions, comparisons, "best" queries), get AI search volume:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"language_code": "en", "location_code": 2840, "keywords": ["<KEYWORD_1>", "<KEYWORD_2>", "<KEYWORD_N>"]}]'
```

**Max 1000 keywords per request.** Returns `ai_search_volume` (current) and `ai_monthly_searches[]` (12-month history). Keywords with rising AI volume are especially valuable — they indicate growing AI search traffic.

### Step 6: Classify & Prioritize

Score each keyword using a composite prioritization:

| Factor                 | Weight | Logic                                                          |
| ---------------------- | ------ | -------------------------------------------------------------- |
| Search Volume          | 25%    | Higher = better. Normalize to 0-100 scale.                     |
| Keyword Difficulty     | 25%    | Lower = better. Invert: score = 100 - difficulty.              |
| CPC / Commercial Value | 20%    | Higher CPC = more commercial intent = higher value.            |
| Search Intent          | 15%    | Prioritize commercial > transactional > informational for GTM. |
| AI Search Volume       | 15%    | Higher = better. Rising trend = bonus.                         |

Group keywords into clusters by topic/intent:

- **Brand keywords** — queries containing brand name
- **Product keywords** — specific product/feature terms
- **Problem keywords** — pain points and questions
- **Comparison keywords** — "X vs Y", "best X", "X alternative"
- **Informational keywords** — how-to, guides, tutorials

### Step 7: Deliver Results

Output as a single chat message with these sections:

```
## SEO Keyword Research: [Topic/Domain]

### Key Findings
- Total keywords analyzed: X
- High-opportunity keywords found: X
- Average keyword difficulty: X/100
- Total monthly search opportunity: X searches
- Keywords with AI search volume data: X

### Top Keywords by Opportunity

| Keyword | Volume | KD | CPC | AI Vol | Intent | Priority |
|---------|--------|-----|-----|--------|--------|----------|
| keyword 1 | 2,400 | 25 | $4.50 | 89 ↑ | commercial | High |
| keyword 2 | 1,800 | 18 | $3.20 | 153 ↑ | informational | High |
| ... | | | | | | |

### Keyword Clusters

#### 🎯 [Cluster Name] (X keywords, Xk total volume)
Top terms: `keyword a` (1.2k), `keyword b` (800), `keyword c` (500)
**Content angle:** [Suggested content type and topic]

#### 🎯 [Cluster Name] ...

### Competitor Gaps (if applicable)
Keywords [competitor] ranks for that [target] doesn't:

| Keyword | Volume | Competitor Rank | KD |
|---------|--------|----------------|-----|
| ... | | | |

### Recommended Content Strategy
1. **[Priority 1]** — Target `keyword` cluster with [content type]. Est. traffic: Xk/mo.
2. **[Priority 2]** — ...
3. **[Priority 3]** — ...
```

## Output Format

**Output as a chat message, NOT a saved file.** Include all data inline.

**Writing rules:**

- Lead with numbers. Every keyword needs volume, difficulty, and CPC.
- Sort tables by the Priority column (composite score).
- Cap the main table at 20 keywords. Mention total count analyzed.
- Cluster names should be descriptive ("Slack Alternatives", "Team Chat Pricing").
- Content strategy recommendations must be specific and actionable.

## Error Handling

**DataForSEO returns empty results:** Try broader seed keywords, check location/language settings.
**Low search volume for niche topics:** Use keyword_ideas endpoint for broader expansion. Consider long-tail variations.
**API authentication fails:** Verify `DUET_API_KEY` is available. Test with: `curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/dataforseo_labs/google/keyword_suggestions/live" -H "Authorization: Bearer $DUET_API_KEY" -H "Content-Type: application/json" -d '[{"keyword":"test","language_code":"en","location_code":2840,"limit":1}]'`
