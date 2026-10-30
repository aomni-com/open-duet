# Firecrawl

Firecrawl is the unattended scraping and browser-automation service in the
catalog. Crawl and extract jobs use caller-owned ids for polling; browser
sessions use the same ownership boundary. Browser execution pricing follows
the vendor's minute-based rates in the definition and probe.

The API training scraper and lander still call Firecrawl directly. Catalog
calls use the Convex service vault and the admitted routes in `services/firecrawl/definition.ts`.

Vault source: `FIRECRAWL_API_KEY`. Keep the API and lander copies for their
direct callers.

Official documentation reviewed 2026-10-13: [Firecrawl API docs](https://docs.firecrawl.dev).
