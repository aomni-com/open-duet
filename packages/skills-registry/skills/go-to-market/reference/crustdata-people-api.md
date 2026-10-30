# People API Reference

Use the [shared request conventions](crustdata.md). All endpoints here are POST.

## Enrich profiles

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/person/enrich" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "professional_network_profile_urls":["https://www.linkedin.com/in/abhilash-chowdhary/"],
    "fields":["basic_profile","social_handles","experience","education","skills","professional_network"]
  }'
```

Submit at most 25 profile URLs together. `fields` is an array, and defaults to
only `basic_profile` and `social_handles`; request work history and education
explicitly. The response is a top-level array with one entry per input:
`{matched_on, match_type, match_status, matches}`. Each match has a
`confidence_score` and `person_data`. Check the status and matches before reading:

| Path under `person_data` | Use |
| --- | --- |
| `basic_profile.name`, `.current_title`, `.headline`, `.summary`, `.location` | Identity and current role |
| `basic_profile.profile_picture_permalink` | Profile photo |
| `social_handles.professional_network_identifier.profile_url` | Canonical profile URL |
| `experience.employment_details.current[]`, `.past[]` | Roles with names, titles, and dates |
| `experience.years_of_experience_raw` | Career experience |
| `education.schools[]` | Education |
| `skills.professional_network_skills[]` | Skills |
| `professional_network.connections`, `.followers` | Network metrics |

Photo permalinks can serve valid images as `binary/octet-stream`; validate the
downloaded image bytes rather than rejecting that Content-Type alone. A missing
photo is allowed — do not substitute another person's image.

`not_found` is not a profile; `redacted` must not be retried or bypassed with
live enrichment. Do not add email or phone fields to a standard profile request.
Use the [FullEnrich reference](fullenrich.md) for the contact workflow, or consult
[Crustdata Contact Enrich](https://docs.crustdata.com/person-docs/contact/enrich.md)
when specifically needed. Contact fields have additional charges.

For a stale or absent indexed profile, `/person/professional_network/enrich/live`
accepts `professional_network_profile_urls` and `fields` in a POST body. It
retrieves fresh data at a higher cost (7 credits/profile) and requires live
access. Use it deliberately, not as an automatic retry of every empty response.

## Indexed search

```bash
curl -sS "$DUET_API_URL/v1/services/crustdata/person/search" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-api-version: 2025-11-01" \
  -d '{
    "filters":{"op":"and","conditions":[
      {"field":"experience.employment_details.current.company_website_domain","type":"=","value":"hubspot.com"},
      {"field":"experience.employment_details.current.title","type":"(.)","value":"engineering"}
    ]},
    "fields":["basic_profile","social_handles","experience.employment_details.current"],
    "limit":20
  }'
```

Response: `{profiles, next_cursor, total_count}`. Each profile has nested
`basic_profile`, `social_handles`, and other requested sections. Verify current
employment on each hit before using it as a contact. Search returns the employer
URL in `experience.employment_details.current[].company_website`; compare its
normalized hostname with the domain filter. `company_website_domain` is a filter
alias, not a returned search field (enrichment does return the bare domain).
`company_name` is the search
field; the returned employment record uses `name`. Filters over employment
without `.current` include past employers too.

Use `next_cursor` as `cursor` with the same query to paginate. Conditions use
`field`, `type`, and `value`. Group with `and` or `or`. Operators include `=`,
`!=`, `in`, `not_in`, `>`, `<`, `=>`, `=<`, `(.)` (all words), and `[.]` (exact
phrase). A pipe in a `(.)` value is not an OR expression; use an `or` group.
For seniority and other enumerated values, discover the exact indexed spelling
instead of guessing.

`/person/search/autocomplete` accepts, for example,
`{"field":"experience.employment_details.current.title","query":"VP","limit":5}`.
Read `suggestions[]` and use its `value` entries in your search filters. Employer autocomplete
uses `.current.name`, while employer search filters use `.current.company_name`.

## Live search

`/person/professional_network/search/live` uses a flat array of uppercase fields,
for example
`{"filters":[{"field":"CURRENT_COMPANY","type":"in","value":["HubSpot"]},{"field":"CURRENT_TITLE","type":"in","value":["CTO"]}],"page":1}`.
Do not send indexed dotted fields or a condition tree. Prefer indexed search
unless the task requires fresh retrieval; consult the live reference for its
pagination and response contract.

Sources: [enrich](https://docs.crustdata.com/person-docs/enrichment/reference.md),
[search](https://docs.crustdata.com/person-docs/search/reference.md),
[live enrich](https://docs.crustdata.com/person-docs/enrichment/live-enrich),
[live search](https://docs.crustdata.com/person-docs/search/live-search).
