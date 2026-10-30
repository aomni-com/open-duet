# Catalog services

Each service owns its vendor-specific rationale, official-doc audit, and
operational boundaries in the README below. Shared admission, pricing, hook,
vault, and query-forwarding rules live in the [catalog README](../README.md).
Each runtime definition and any provider-specific pricing, routes, or hooks live
beside this index under `<id>/`; `../src/vendors.ts` is only the small registry
assembly point. Fixtures remain under [`fixtures/`](../fixtures/).

- [Crustdata](crustdata/README.md)
- [DataForSEO](dataforseo/README.md)
- [ElevenLabs](elevenlabs/README.md)
- [Firecrawl](firecrawl/README.md)
- [FullEnrich](fullenrich/README.md)
- [SocialAPI](socialapi/README.md)
