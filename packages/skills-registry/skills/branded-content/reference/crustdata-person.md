# Crustdata Person Enrichment

Use [the shared People API reference](../../go-to-market/reference/crustdata-people-api.md)
for request bodies, response fields, no-match handling, and fresh retrieval.

For branded content, POST `/person/enrich` through Duet with a
`professional_network_profile_urls` array and explicitly request
`basic_profile`, `social_handles`, `experience`, `education`, and `skills`.
Check each input's `match_status` and `matches`, then read the selected
`matches[].person_data`. The photo is
`basic_profile.profile_picture_permalink`; names and titles are also inside
`basic_profile`. Base enrichment costs 1 vendor credit per matched profile;
contact and developer-data add-ons cost more. Duet meters successful calls
separately.
