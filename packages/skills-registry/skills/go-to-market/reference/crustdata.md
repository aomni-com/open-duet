# Crustdata API

## Requests through Duet

Use `$DUET_API_URL/v1/services/crustdata` as the base URL. Send
`Authorization: Bearer $DUET_API_KEY`, `Content-Type: application/json`, and
`x-api-version: 2025-11-01`. Duet supplies the upstream Crustdata credential;
never look for or request a vendor key inside the workspace.

All search, identify, and enrichment examples below use POST with a JSON body.
Identifier lists and `fields` are JSON arrays. Search conditions use `field`;
sort entries use `field` and `order`. Enrichment returns a top-level array of
input matches, not a flat profile. Check every entry's `matches` before reading
`matches[].company_data` or `matches[].person_data`.

## Choose the endpoint

| Endpoint | Purpose | Vendor credits |
| --- | --- | --- |
| `/company/identify` | Resolve ambiguous company identifiers | Free |
| `/company/enrich` | Company sections selected by `fields` | 2 base; add-ons extra |
| `/company/search` | Indexed company search | 0.03/result base |
| `/person/enrich` | Person profile and employment history | 1 base; add-ons extra |
| `/person/search` | Indexed person search | 0.03/result base |
| `/company/search/autocomplete`, `/person/search/autocomplete` | Discover valid filter values | Free |
| `/social_post/search` | Indexed post search | 0.5/post |
| `/social_post/professional_network/enrich/live` | Fresh posts for an author or post URL | 1/post base |
| `/social_post/professional_network/search/live` | Fresh keyword post search | 1/post; exact match costs more |

Vendor credits are separate from Duet's service-proxy charge per successful call.
Field add-ons and live retrieval can cost more; consult [current pricing](https://docs.crustdata.com/general/pricing.md).

## Workflows

- **Company:** identify only when identity is ambiguous; otherwise enrich a known
  domain directly. Request all needed sections in one call — omitted `fields`
  returns only basic company information.
- **People:** search with current-employer filters, verify the returned employer,
  then enrich selected profile URLs together (up to 25). Explicitly request
  `experience`, `education`, and `skills` if the task needs them.
- **Pagination:** pass `next_cursor` back as `cursor` with the same query, stop
  when it is null or the task's result budget is met. Do not repeatedly start
  the same search from page one. Prefer small limits while tuning filters.
- **Large approved sets:** `/batch/company/search`, `/batch/company/enrich`,
  `/batch/person/search`, and `/batch/person/enrich` create asynchronous jobs.
  Read the [batch reference](https://docs.crustdata.com/llms.txt) before submitting;
  wrap search filters in `{ "op": "and", "conditions": [...] }` even for one
  condition, set `max_results` explicitly, retain the returned batch ID, and poll
  `/batch/{batch_id}` with a deadline. Download completed results; stop on failure.
- **Errors:** respect `Retry-After` on 429, bound retries, and stop on permission
  or credit errors rather than repeating the same request. Field access varies
  by account; narrow a denied field only if the task can proceed without it.

## References

- [Company identify, enrich, and search](crustdata-company-api.md)
- [People enrich and search](crustdata-people-api.md)
- [LinkedIn posts](crustdata-linkedin-api.md)
- [Watchers](crustdata-watcher-api.md)
- [Provider documentation index](https://docs.crustdata.com/llms.txt) — use the
  Markdown links for current schemas, filter fields, and account-specific limits.
