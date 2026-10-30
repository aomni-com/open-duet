# Researching an Account

Research a target company and deliver findings as a concise, data-driven executive summary with AI-generated infographics — all as chat messages.

## Input

- **Company name or domain**: The account to research
- **Solution context** (optional): If available, use for relevance scoring

## Instructions

### Step 1: Gather Data

Run these in parallel:

1. **Crustdata enrichment**: Use Company Identification API if needed (`POST /company/identify`), then Company Enrichment API (`POST /company/enrich`) with fields: `["basic_info","locations","taxonomy","revenue","headcount","funding","web_traffic","hiring","followers","news","competitors"]`. See [../reference/crustdata-company-api.md](../reference/crustdata-company-api.md).

2. **Web research**: Run 4-6 WebSearch queries focused on recent news, strategic initiatives, challenges, and industry trends. Use WebFetch on the best 3-5 sources. Prioritize last 6 months.

### Step 2: Generate Infographic — Company Profile

Use the media-creation skill (GPT Image 2.5 Flare — default) to generate an infographic image summarizing the company.

**Prompt guidance**: Create a clean, modern infographic titled "[Company Name] — Account Intelligence" showing: company name, industry, HQ, employee count + growth %, funding stage/total, web traffic trend, and 2-3 key business highlights. Professional dark or gradient background, clear typography.

### Step 3: Deliver Company Profile Message

Send a message with the infographic from Step 2 followed by a structured exec summary:

```
## [Company Name] — Executive Summary

**One-liner:** [What the company does in ≤15 words]

| Metric | Value |
|--------|-------|
| Employees | X (↑/↓ Y% YoY) |
| Funding | $Xm total (Series X, YYYY) |
| Est. Revenue | $X–Ym |
| Web Traffic | Xk/mo (↑/↓ Y% MoM) |
| LinkedIn Followers | Xk (↑/↓ Y%) |

### Recent Developments
- **[Date]** — [Event with specific numbers] ([Source])
- **[Date]** — [Event with specific numbers] ([Source])
- **[Date]** — [Event with specific numbers] ([Source])
```

Every row must have a real number. No placeholders, no "N/A" unless data truly doesn't exist. Cite the source for each development.

### Step 4: Generate Infographic — Opportunities

Use the media-creation skill (GPT Image 2.5 Flare — default) to generate a second infographic.

**Prompt guidance**: Create an "Opportunities & Challenges" infographic for [Company Name]. Show 3 key challenges/opportunities as cards or sections, each with a short title, one-line description, and a priority tag (High/Medium/Low). Clean, professional layout.

### Step 5: Deliver Strategy Message

Send a second message with the infographic from Step 4 followed by:

```
## Strategic Assessment

### Key Challenges & Opportunities
1. **[Title]** (Priority: High/Med/Low)
   - _Evidence:_ [Specific data point or quote with source]
   - _Business impact:_ [One sentence, quantified if possible]
   - _Solution angle:_ [How this connects to our value — if context available]

2. ...
3. ...

### Recommended Next Actions
1. [Specific action] — _because [rationale tied to data above]_
2. ...
3. ...

### Sources
- [Source title](URL) — [what it contributed]
- ...
```

## Output Format

**Output everything as chat messages, NOT as saved files.** Two messages total:

1. **Company Profile** — infographic + exec summary with metrics table + recent news
2. **Strategic Assessment** — opportunities infographic + prioritized challenges + next actions + sources

**Writing rules:**

- Lead with numbers, not adjectives. "Revenue est. $12–18M" not "significant revenue."
- Every claim needs a source. Inline-link or cite at bottom.
- Use tables for structured comparisons. Use bold for key figures.
- No filler. Every sentence must contain a fact, number, or actionable insight.
- Keep the entire output under 500 words of text (excluding tables and links).

## Error Handling

**Crustdata returns nothing:** Fall back to WebSearch for company basics. Try another verified identifier if identity is uncertain.
**No recent sources:** Broaden search terms, try industry-level news, check SEC filings.
**Image generation fails:** Deliver the report without images — the text content is the priority.
