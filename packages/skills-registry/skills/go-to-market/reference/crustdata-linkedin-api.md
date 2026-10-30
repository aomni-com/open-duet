# LinkedIn Posts API Reference

Use the [shared request conventions](crustdata.md). All endpoints here are POST.
Choose indexed search for discovery, live enrichment for fresh author/post
retrieval, and live keyword search when current keyword coverage matters.

## Fresh posts for a person, company, or post URL

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/social_post/professional_network/enrich/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{"professional_network_profile_url":"https://www.linkedin.com/in/satyanadella","limit":10}'
```

Choose one identifier:

- Person: `professional_network_profile_url` (singular).
- Company: `company_domain`, `company_name`, `crustdata_company_id`, or
  `company_professional_network_url`.
- One post: `social_post_url`.

The response is `{posts: [...]}`. Post fields include `share_url`, `share_urn`,
`text`, `date_posted`, `actor`, and `engagement`. Author details and engagement
counts are nested objects; do not read them as top-level fields. Keep the
requested limit bounded. Reactors/comments are paid add-ons; consult the
provider schema before requesting them.

## Indexed search

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/social_post/search" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "filters":{"field":"text","type":"[.]","value":"Generative AI"},
    "sorts":[{"field":"date_posted","order":"desc"}],
    "limit":10
  }'
```

Response: `{posts, next_cursor, total_count}`. For an author's indexed posts,
filter `actor.professional_network_url` with `=` and their full profile URL.
For a specific post, use `share_url`. `[.]` is an exact phrase match; combine
conditions with `{"op":"and","conditions":[...]}` or `or`.
Pass `next_cursor` as `cursor` with the same query until null or the task limit.
Indexed results may lag the live profile; use live retrieval for fresh activity.

## Live keyword search

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/social_post/professional_network/search/live" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{"keyword":"Generative AI","limit":10}'
```

This endpoint returns a **bare array of posts**, not an object with a `posts`
property. Use `limit` to bound the request. `exact_keyword_match` increases cost;
read the provider reference before using advanced filters or pagination.
Reactors/comments are not available here; use live enrichment for those.

Sources: [indexed search](https://docs.crustdata.com/social-post-docs/indexed-search/reference.md),
[live enrichment](https://docs.crustdata.com/social-post-docs/enrichment/introduction),
[live search](https://docs.crustdata.com/social-post-docs/search/introduction),
[pricing](https://docs.crustdata.com/general/pricing.md).
