# Looking Up Firmographics

Gather company firmographic data using the Crustdata API for structured data and web search for supplementary context.

## Input

- **Company identifier**: Domain (e.g., `acme.com`) or company name (e.g., `Acme Corp`)

## Instructions

### Step 1: Identify Company via Crustdata

Use the Company Identification API (`POST /company/identify`) to resolve the company. Pass either `domains` (for domains) or `names` (for names), each a JSON array. This endpoint is free (no credits).
See [../reference/crustdata-company-api.md](../reference/crustdata-company-api.md) for request format and parameters.

If multiple matches are returned, present the top results to the user with AskUserQuestion to confirm the right company.

### Step 2: Enrich Company via Crustdata

Use the Company Enrichment API (`POST /company/enrich`) to get full firmographics.
See [../reference/crustdata-company-api.md](../reference/crustdata-company-api.md) for request format and parameters.

Request with fields: `["basic_info","locations","taxonomy","revenue","headcount","funding","web_traffic","hiring","people"]`

Read the selected `matches[].company_data` from the enrichment array. Company sections are nested; `people` includes founders and decision makers when permitted. For contact discovery, use the [People API](../reference/crustdata-people-api.md).

This returns structured data for:

- Company basics (name, website, LinkedIn, year founded, HQ, employee range)
- Headcount (current count, growth rates, breakdown by role/region)
- Funding (total investment, last round, investors)
- Web traffic (monthly visitors, traffic sources)
- Job openings (count, growth, by function)
- Taxonomy (industries, NAICS/SIC codes)
- Founders

See [../reference/crustdata.md](../reference/crustdata.md) for full API overview.

### Step 3: Supplement with Web Search

Use WebSearch for information not available in Crustdata:

- Recent news and announcements
- Key products/services descriptions
- Strategic initiatives or partnerships
- Market positioning

**Recommended searches:**

1. `"[company name]" news [current year]`
2. `"[company name]" products services`

### Step 4: Compile Firmographics JSON

Create a `firmographics.json` file combining Crustdata structured data with web research. This is our report schema, not the provider response: map `crustdata_company_id` to `company_id`, `basic_info` to company basics, `headcount.total` to `linkedin_headcount`, and the corresponding nested sections to the report fields. Leave unavailable values null; never copy the examples as facts:

```json
{
  "company_name": "Acme Corporation",
  "company_id": 12345,
  "company_website_domain": "acme.com",
  "company_website": "https://www.acme.com",
  "company_description": "Acme Corporation provides enterprise software solutions for supply chain management...",
  "industry": "Enterprise Software",
  "linkedin_industries": ["Software Development", "Technology"],
  "hq_country": "United States",
  "headquarters": "San Francisco, California",
  "employee_count_range": "1,001-5,000",
  "linkedin_headcount": 2500,
  "headcount_growth": {
    "mom": 2.1,
    "qoq": 5.3,
    "yoy": 18.7
  },
  "year_founded": "2010",
  "linkedin_profile_url": "https://linkedin.com/company/acme-corp",
  "estimated_revenue_lower_bound_usd": 50000000,
  "estimated_revenue_upper_bound_usd": 100000000,
  "funding": {
    "total_investment_usd": 75000000,
    "last_round_type": "Series C",
    "last_round_amount_usd": 50000000,
    "investors": ["Sequoia Capital", "Andreessen Horowitz"]
  },
  "web_traffic": {
    "monthly_visitors": 250000,
    "traffic_source_search_pct": 45,
    "traffic_source_direct_pct": 30
  },
  "job_openings_count": 42,
  "key_products_services": ["Supply Chain Platform", "Inventory Management"],
  "recent_news": [
    {
      "headline": "Acme Corp Raises $50M Series C",
      "date": "2024-09-15",
      "source": "TechCrunch"
    }
  ],
  "data_sources": ["crustdata_api", "web_search"],
  "gathered_date": "2024-12-30"
}
```

### Step 5: Save and Present

Save the `firmographics.json` file and present a summary to the user highlighting:

- Company overview
- Size and growth trajectory
- Funding status
- Key metrics (web traffic, job openings)

## Quality Checklist

Before completing, verify:

- [ ] Company identity confirmed via Crustdata (correct match)
- [ ] Crustdata enrichment data included (headcount, funding, traffic)
- [ ] Industry classification is specific (not just "Technology")
- [ ] Location includes at least city and country
- [ ] Growth metrics included (headcount trends)
- [ ] Business description is substantive (2-3 sentences minimum)
- [ ] JSON is valid and properly formatted

## Error Handling

**Crustdata API returns no results:**

- Fall back to WebSearch-based research
- Try alternative identifiers (name vs domain vs LinkedIn URL)
- Supplement missing indexed data with web research; record which source each fact came from.

**Company not found anywhere:**

- Try alternative spellings or parent company names
- Ask user for clarification if multiple companies match

**Limited information available:**

- Note which fields have uncertain or missing data
- Proceed with available information rather than blocking
