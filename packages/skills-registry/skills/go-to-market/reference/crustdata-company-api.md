# Company API Reference

Use the [shared request conventions](crustdata.md). All endpoints here are POST.

## Identify

Resolve uncertain identity before spending on enrichment. Submit exactly one
identifier array: `domains`, `names`, `professional_network_profile_urls`, or
`crustdata_company_ids` (integer IDs); at most 25 identifiers.

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/company/identify" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{"domains":["hubspot.com"],"exact_match":true}'
```

The response is an array of `{matched_on, match_type, matches}`. Each candidate
has `confidence_score` and `company_data` containing `crustdata_company_id` and
`basic_info`. Verify the domain and name before choosing a candidate; a single
input can have several matches. An empty `matches` array means no match.

## Enrich

`/company/enrich` accepts the same identifier arrays and `exact_match` option.
Request the sections you need explicitly; the default is only `basic_info`.

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/company/enrich" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{"domains":["hubspot.com"],"exact_match":true,"fields":["basic_info","locations","taxonomy","revenue","headcount","funding","hiring","web_traffic","people"]}'
```

Read each selected `matches[].company_data`. Common sections:

| Section | Data |
| --- | --- |
| `basic_info` | `name`, `primary_domain`, `website`, `description`, `year_founded`, `professional_network_url` |
| `locations`, `taxonomy`, `revenue` | HQ, industries, estimated revenue |
| `headcount` | `total`, `growth_percent`, role/region breakdowns |
| `funding` | `total_investment_usd`, `last_round_type`, `last_round_amount_usd`, investors |
| `hiring`, `followers` | Job openings and follower metrics |
| `web_traffic`, `seo`, `competitors` | Traffic, search performance, competitor domains |
| `employee_reviews`, `software_reviews` | Employee and product ratings |
| `news`, `people` | Articles; founders, decision makers, executives |

Include `basic_info` alongside other groups to retain identity. A field denied
by the account returns 403; do not interpret that as a company with no data.
For an unmatched domain, try another verified identifier or supplement with web
research. There is no `enrich_realtime` flag on this endpoint.

## Indexed search

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/company/search" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "filters":{"op":"and","conditions":[
      {"field":"locations.country","type":"=","value":"USA"},
      {"field":"headcount.total","type":"=>","value":50}
    ]},
    "fields":["crustdata_company_id","basic_info.name","basic_info.primary_domain","headcount.total"],
    "sorts":[{"field":"headcount.total","order":"desc"}],
    "limit":20
  }'
```

Response: `{companies, next_cursor, total_count}`. Company records contain
nested sections like enrichment. Send `next_cursor` as `cursor` while retaining
the query and sorts. Use `field`, not `filter_type` or `column`. Comparisons
include `=`, `!=`, `in`, `not_in`, `>`, `<`, `=>`, `=<`; combine conditions with
`and`/`or`. Consult the reference for field-specific operators and ranked search.

Discover stored values with `/company/search/autocomplete`, for example
`{"field":"locations.country","query":"Uni","limit":5}`. Read `suggestions[]`
and use its `value` entries in search filters.

## Live search

When freshness requires it and account access permits, use
`/company/professional_network/search/live`. Its filters are a flat array with
uppercase fields, for example
`{"filters":[{"field":"COMPANY_HEADCOUNT","type":"in","value":["11-50"]}],"page":1}`.
Do not send the indexed condition tree to live search. Live search costs more;
read its provider reference before adding filters or paginating.

Sources: [identify](https://docs.crustdata.com/company-docs/identify/introduction.md),
[enrich](https://docs.crustdata.com/company-docs/enrichment/reference.md),
[search](https://docs.crustdata.com/company-docs/search/reference.md),
[live search](https://docs.crustdata.com/company-docs/search/live-search).
