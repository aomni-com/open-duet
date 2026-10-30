# Profiling a Competitor

Gather a quick competitor profile using Crustdata and web search. Deliver a concise, data-dense snapshot as a single chat message.

## Input

- **Competitor identifier**: Company name or domain
- **Product context** (optional): If available, frame toward relevant comparison points

## Instructions

### Step 1: Identify and Enrich via Crustdata

Use Company Identification API (`POST /company/identify`) if needed, then Company Enrichment API (`POST /company/enrich`) with fields: `["basic_info","locations","taxonomy","revenue","headcount","funding","web_traffic","hiring","employee_reviews","software_reviews","seo","competitors","followers","news"]`. See [../reference/crustdata-company-api.md](../reference/crustdata-company-api.md).

### Step 2: Gather Product & Pricing via Web Search

Run 3-4 WebSearch queries for product features, pricing, and positioning. Use WebFetch on the best 2-3 results.

### Step 3: Deliver Profile Message

Send a single message structured as:

```
## [Company Name] — Quick Profile

**One-liner:** [What they do in ≤15 words]

| Field | Value |
|-------|-------|
| Industry | [Specific category] |
| HQ | [City, Country] |
| Founded | [Year] |
| Employees | X (↑/↓ Y% YoY) |
| Funding | $Xm total ([Last round type], [Year]) |
| Key Investors | [Top 2-3] |
| G2 Rating | X.X/5 (N reviews) |
| Web Traffic | Xk/mo |
| LinkedIn Followers | Xk |

### Product
**[Product name]** — [category]. [One sentence on core value prop.]

Key features: [feature 1], [feature 2], [feature 3], [feature 4], [feature 5]

Target market: [company sizes] in [industries], sold to [buyer personas]

### Pricing
| Tier | Price | Key Limits |
|------|-------|------------|
| ... | ... | ... |

### Competitive Landscape
Related companies: [company 1], [company 2], [company 3] (via Crustdata)
```

Every field must have a real value. No "N/A" unless data genuinely doesn't exist. Keep the entire message under 300 words.

**Output as a chat message, NOT a saved file.**

## Error Handling

**Crustdata returns nothing:** Fall back to WebSearch. Try another verified identifier if identity is uncertain.
**Pricing not public:** Note as "Contact sales" and check third-party sources.
