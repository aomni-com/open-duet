# Slice 07 redacted golden payloads

This review fixture follows one eligible conversion through every server
adapter. It is evidence for the provider boundary, not a second payload
registry; executable exact shapes live in the
[adapter golden tests](../../../packages/backend/convex/domains/campaigns/destinationAdapters.test.ts).

Shared input:

- conversion ID: `conversion-123`;
- occurred at: `2026-03-19T04:00:00.000Z`;
- attribution captured at: `2026-03-18T04:00:00.000Z`;
- value: `12.34 USD` in major units;
- source: `https://lander.example/signup?campaign=organic`;
- identity: normalized and hashed in server memory, redacted here;
- account IDs, access tokens, OAuth values, and API keys: synthetic or redacted.

| Provider | Current boundary | Dedupe field | Chosen click identity | Monetary shape |
| --- | --- | --- | --- | --- |
| Meta | Graph `v26.0` pixel events | `event_id: conversion-123` | `fbclid` represented as `fbc` using attribution capture time | `12.34 USD` |
| Google | Data Manager `v1 events:ingest` | `transactionId: conversion-123` | `gclid` (wins over fixture `gbraid`/`wbraid`) | `12.34 USD` |
| Reddit | Conversion Events `v3` | `conversion_id: conversion-123` | `rdt_cid` as `click_id` | `12.34 USD` |
| OpenAI | Conversions `v1` | `id: conversion-123` | `oppref` | `1234 USD` minor units, exponent `2` |

All four account mappings remain disabled in campaign constants. The golden
requests run only through injected HTTP in tests; this report contains no live
credential, provider request, or customer identity.
