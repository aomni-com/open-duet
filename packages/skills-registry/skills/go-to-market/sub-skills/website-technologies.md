# Website Technologies Lookup

Identify the technology stack of any website — CMS, frameworks, analytics tools, hosting, security, and more. Useful for competitive intelligence, sales prospecting (technology-based targeting), and technical audits.

## Service proxy

Use the `$DUET_API_URL/v1/services/dataforseo` proxy with `$DUET_API_KEY`. The routes below are admitted by the catalog.

## Input

- **Domain(s)**: One or more domains to analyze (e.g. `duet.so`, `slack.com`)

## Instructions

### Step 1: Lookup Technologies

For each domain, call the domain technologies endpoint:

```bash
curl -s -X POST "$DUET_API_URL/v1/services/dataforseo/v3/domain_analytics/technologies/domain_technologies/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"target": "DOMAIN"}]'
```

**Cost:** $0.01/domain

**Response fields:**

- `domain` — target domain
- `title` — page title
- `description` — meta description
- `domain_rank` — domain authority rank
- `last_visited` — when DataForSEO last crawled
- `emails` — contact emails found
- `social_graph_urls` — social media profiles
- `phone_numbers` — phone numbers found
- `technologies` — nested object organized by category:
  - `security` — HSTS, SSL certificates, etc.
  - `servers` — PaaS (Vercel, Heroku), CDN (Cloudflare), web servers (Nginx)
  - `content` — CMS (WordPress, Webflow), blog platforms
  - `analytics` — Google Analytics, Segment, Mixpanel, PostHog
  - `marketing` — HubSpot, Intercom, Drift
  - `javascript_frameworks` — React, Next.js, Vue
  - `programming_languages` — Node.js, Python, Ruby
  - `payment` — Stripe, PayPal
  - `ecommerce` — Shopify, WooCommerce

### Step 2: Deliver Results

Output as a chat message:

```
## Technology Stack: [domain]

**[Title]** — [Description]
Domain Rank: X | Last Crawled: [Date]

### Tech Stack

| Category | Technologies |
|----------|-------------|
| Hosting / PaaS | Vercel |
| CDN | Cloudflare |
| JS Framework | React, Next.js |
| Analytics | PostHog, Google Analytics |
| Marketing | Intercom |
| Security | HSTS, Let's Encrypt |
| Payment | Stripe |

### Contact Info
- **Emails:** team@example.com
- **Social:** [LinkedIn](url), [Twitter](url)
- **Phone:** +1-XXX-XXX-XXXX

### Insights
- [Notable technology choices and what they suggest about the company]
- [Sales angle: tools they use that integrate with or compete with our product]
```

**For multiple domains**, present as a comparison table:

```
### Technology Comparison

| Technology | domain1.com | domain2.com | domain3.com |
|-----------|-------------|-------------|-------------|
| CMS | WordPress | Webflow | Custom |
| Analytics | GA4 | Segment | PostHog |
| CDN | Cloudflare | Fastly | Vercel Edge |
| ... | | | |
```

## Output Format

**Output as a chat message, NOT a saved file.**

## Use Cases

- **Sales prospecting:** Find companies using a specific technology (e.g., find all companies using HubSpot for potential migration)
- **Competitive analysis:** Compare tech stacks across competitors
- **Technical audit:** Understand current stack before suggesting improvements
- **Integration assessment:** Check which tools a prospect uses to highlight integration opportunities

## Error Handling

**Domain not found:** The domain may be too new or low-traffic for DataForSEO to have crawled. Try the main domain without subdomains.
**Sparse results:** Some domains block crawlers or have minimal frontend technologies detectable.
