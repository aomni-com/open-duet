# Researching a Competitor

Research a competitor and deliver findings as a concise, data-driven executive summary with AI-generated infographics — all as chat messages.

## Input

- **Competitor name or domain**: The competitor to research
- **Product context** (optional): If available, use for comparison framing

## Instructions

### Step 1: Gather Data

Run these in parallel:

1. **Crustdata enrichment**: Use Company Identification API if needed (`POST /company/identify`), then Company Enrichment API (`POST /company/enrich`) with fields: `["basic_info","locations","taxonomy","revenue","headcount","funding","web_traffic","hiring","employee_reviews","software_reviews","seo","competitors","followers","news"]`. See [../reference/crustdata-company-api.md](../reference/crustdata-company-api.md).

2. **Web research**: Run 5-8 WebSearch queries covering product/features, pricing, positioning, customer reviews, and recent news. Use WebFetch on the best 3-5 sources. Prioritize last 12 months.

### Step 2: Generate Infographic — Company Overview

Use the media-creation skill (GPT Image 2.5 Flare — default) to generate an infographic image summarizing the competitor's profile.

**Prompt guidance**: Create a clean, modern infographic titled "[Competitor Name] — Competitive Overview" that includes: company name, logo description, founded year, HQ, employee count, funding total, key product category, and 3-4 key metrics (G2 rating, web traffic, headcount growth %). Use a professional dark or gradient background with clear typography.

### Step 3: Deliver Company Overview Message

Send a message with the infographic from Step 2 followed by a structured exec summary:

```
## [Competitor Name] — Competitive Profile

**One-liner:** [What they do in ≤15 words]

| Metric | Value |
|--------|-------|
| Employees | X (↑/↓ Y% YoY) |
| Funding | $Xm total (Series X, investors) |
| G2 Rating | X.X/5 (N reviews) |
| Web Traffic | Xk/mo (↑/↓ Y% MoM) |
| Headcount Growth | ↑/↓ X% YoY |
| Organic Keywords | Xk |

### Pricing
| Tier | Price | Key Limits |
|------|-------|------------|
| [Name] | $X/mo | [Limits] |
| ... | ... | ... |

**Pricing model:** [per-seat / usage / flat — one sentence]
```

Every row must have a real number. No placeholders, no "N/A" unless data truly doesn't exist.

### Step 4: Generate Infographic — Competitive Analysis

Use the media-creation skill (GPT Image 2.5 Flare — default) to generate a second infographic.

**Prompt guidance**: Create a "Strengths vs Weaknesses" infographic for [Competitor Name]. Left side green: 3-4 key strengths. Right side red: 3-4 key weaknesses. Include a "Threat Level" indicator (High/Medium/Low). Clean layout, professional style.

### Step 5: Deliver Analysis Message

Send a second message with the infographic from Step 4 followed by:

```
## Competitive Analysis

### Where They Win
- **[Strength]** — [evidence with specific data point] ([Source])
- ...

### Where They're Vulnerable
- **[Weakness]** — [evidence: customer complaints, missing features, data] ([Source])
- ...

### Threat Assessment
**Overall threat level: [High/Medium/Low]**
[2-3 sentences: why this level, what specifically makes them dangerous or not, quantified where possible]

### Positioning Recommendation
[2-3 sentences on how to compete against them, grounded in the evidence above]

### Sources
- [Source title](URL) — [what it contributed]
- ...
```

## Output Format

**Output everything as chat messages, NOT as saved files.** Two messages total:

1. **Competitive Profile** — infographic + exec summary with metrics + pricing table
2. **Competitive Analysis** — strengths/weaknesses infographic + threat assessment + positioning + sources

**Writing rules:**

- Lead with numbers, not adjectives. "$45M Series C" not "well-funded."
- Every claim needs a source. Inline-link or cite at bottom.
- Use tables for structured comparisons. Use bold for key figures.
- No filler. Every sentence must contain a fact, number, or actionable insight.
- Keep the entire output under 500 words of text (excluding tables and links).

## Error Handling

**Crustdata returns nothing:** Fall back to WebSearch for company basics. Try another verified identifier if identity is uncertain.
**No recent sources:** Broaden search terms, try industry-level news.
**Image generation fails:** Deliver the report without images — the text content is the priority.
