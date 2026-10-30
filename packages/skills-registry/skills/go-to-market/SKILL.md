---
name: go-to-market
target: both
description: Research accounts, enrich leads, research a person into a professional dossier with work history and verified contact details, pick the contacts worth reaching at an account, look up firmographics, query Crustdata and FullEnrich APIs, profile/research/analyze competitors, write sales emails, perform SEO keyword research, Amazon/Google Shopping product research, App Store optimization, AI search visibility analysis, and website technology lookups using DataForSEO.
---

# Go-to-Market

Workflows for account research, lead enrichment, contact discovery, competitive intelligence, sales email writing, SEO keyword research, ecommerce product research, app store optimization, AI search visibility, and website technology analysis.

## Service proxy boundary

Every executable call in these workflows goes through the service proxy with
`$DUET_API_KEY`. Discover routes with `duet services search` and `duet services
show`, then use the returned proxy base and path exactly. Vendor credentials and
vendor hosts never appear in VM instructions.

## Workflows

| Workflow                | When to Use                                                                                              | Reference                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Account Research        | Research a target company — delivers visual report with infographics                                     | [sub-skills/account-research.md](sub-skills/account-research.md)                 |
| Lead Enrichment         | Synthesize research into sales strategies                                                                | [sub-skills/lead-enrichment.md](sub-skills/lead-enrichment.md)                   |
| Contact Search          | Profile one person into a one-page dossier, or pick and rank the contacts worth reaching at an account   | [sub-skills/contact-search.md](sub-skills/contact-search.md)                     |
| Firmographics           | Gather structured company data (industry, size, funding)                                                 | [sub-skills/firmographics.md](sub-skills/firmographics.md)                       |
| Competitor Profile      | Quick competitor company/product profile                                                                 | [sub-skills/competitor-profile.md](sub-skills/competitor-profile.md)             |
| Competitor Research     | In-depth competitor research — delivers visual report with infographics                                  | [sub-skills/competitor-research.md](sub-skills/competitor-research.md)           |
| Competitor Analysis     | SWOT analysis and feature comparison with infographic                                                    | [sub-skills/competitor-analysis.md](sub-skills/competitor-analysis.md)           |
| Email Writing           | Compose sales and follow-up emails                                                                       | [sub-skills/email-writing.md](sub-skills/email-writing.md)                       |
| SEO Keyword Research    | Find high-opportunity keywords, analyze difficulty, competitor gaps                                      | [sub-skills/seo-keyword-research.md](sub-skills/seo-keyword-research.md)         |
| Amazon Keyword Research | Amazon product keyword research, search volume, competitor ASINs                                         | [sub-skills/amazon-keyword-research.md](sub-skills/amazon-keyword-research.md)   |
| Google Shopping         | Product pricing, competitor landscape, and seller analysis                                               | [sub-skills/google-shopping-research.md](sub-skills/google-shopping-research.md) |
| App Store Research      | ASO keyword research for Apple App Store and Google Play                                                 | [sub-skills/app-store-research.md](sub-skills/app-store-research.md)             |
| AI Search Visibility    | Google AI Overview/AI Mode citation tracking, AI search volume, LLM mentions, competitor AI benchmarking | [sub-skills/ai-search-visibility.md](sub-skills/ai-search-visibility.md)         |
| Website Technologies    | Identify tech stack of any website (CMS, analytics, hosting, etc.)                                       | [sub-skills/website-technologies.md](sub-skills/website-technologies.md)         |

## Data Sources

| Source                       | What It Provides                                                                                                                            | Reference                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Crustdata API                | Company firmographics, people profiles, LinkedIn posts, monitoring                                                                          | [reference/crustdata.md](reference/crustdata.md)                                       |
| Crustdata Company API        | Company identification, enrichment, and search                                                                                              | [reference/crustdata-company-api.md](reference/crustdata-company-api.md)               |
| Crustdata People API         | People enrichment and search                                                                                                                | [reference/crustdata-people-api.md](reference/crustdata-people-api.md)                 |
| Crustdata LinkedIn API       | LinkedIn post retrieval and keyword search                                                                                                  | [reference/crustdata-linkedin-api.md](reference/crustdata-linkedin-api.md)             |
| Crustdata Watcher API        | Real-time monitoring watches                                                                                                                | [reference/crustdata-watcher-api.md](reference/crustdata-watcher-api.md)               |
| FullEnrich API               | Contact enrichment (emails, phones), reverse email lookup, people/company search                                                            | [reference/fullenrich.md](reference/fullenrich.md)                                     |
| FullEnrich Enrich API        | Bulk contact enrichment for emails and phone numbers                                                                                        | [reference/fullenrich-enrich-api.md](reference/fullenrich-enrich-api.md)               |
| FullEnrich Reverse Email API | Identify person from email address                                                                                                          | [reference/fullenrich-reverse-email-api.md](reference/fullenrich-reverse-email-api.md) |
| FullEnrich Search API        | People and company search with filters                                                                                                      | [reference/fullenrich-search-api.md](reference/fullenrich-search-api.md)               |
| DataForSEO API               | SEO keyword research, search volume, keyword difficulty, SERP analysis                                                                      | [reference/dataforseo.md](reference/dataforseo.md)                                     |
| DataForSEO Amazon API        | Amazon keyword research, product competitors, search volume                                                                                 | [reference/dataforseo-amazon.md](reference/dataforseo-amazon.md)                       |
| DataForSEO Google Shopping   | Google Shopping product search, sellers, product specs                                                                                      | [reference/dataforseo-google-shopping.md](reference/dataforseo-google-shopping.md)     |
| DataForSEO App Store API     | Apple App Store & Google Play keyword research, app competitors, reviews                                                                    | [reference/dataforseo-app-store.md](reference/dataforseo-app-store.md)                 |
| DataForSEO AI Optimization   | AI search volume, Google AI Mode, AI Overview tracking, LLM Mentions (search, aggregated metrics, top domains, top pages, cross-comparison) | [reference/dataforseo-ai-optimization.md](reference/dataforseo-ai-optimization.md)     |
