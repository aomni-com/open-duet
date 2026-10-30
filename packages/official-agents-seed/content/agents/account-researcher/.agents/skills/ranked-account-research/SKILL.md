---
name: ranked-account-research
description: Decompose an account objective, rank search previews before scraping, and maintain a dated fact ledger with explicit unfound fields.
---

# Ranked Account Research

This skill owns the loop between an account question and an auditable evidence ledger. It does not own provider request shapes; read `go-to-market` and `firecrawl` for those.

## Plan

Write the objective as a decision the seller needs to make. Break it into no more than six questions that are independently researchable. A question must not rely on another researcher's answer or contain two unrelated asks.

Generate no more than eight search queries across the whole plan. Prefer queries that expose primary company pages, filings, job listings, executive statements, and dated reporting. Record each query exactly as run.

## Rank before reading

Search returns previews. Canonicalize URLs, remove duplicates, then score every result before scraping:

| Score | Meaning |
| --- | --- |
| `high` | Likely to answer a named question with primary, recent, or directly attributable evidence |
| `medium` | Relevant context or corroboration, but indirect, older, or weaker authority |
| `low` | Generic, duplicative, off-objective, undated, or unlikely to establish a dossier fact |

Write the score and a one-line reason into `research-plan.md`. Scrape high results first. Read a medium result only when it closes a named gap or independently corroborates a consequential claim. Do not scrape low results by default.

Stop at six scraped pages and two pages from any one domain. If six pages leave a material question open, mark it `unfound` or ask the user before spending more; do not silently widen the crawl.

## Extract atomic evidence

One JSON object per `evidence.jsonl` line:

```json
{"id":"E-001","field":"funding.last_round","status":"found","value":"$20M Series B","source":{"title":"Acme announces Series B","url":"https://acme.example/news/series-b"},"published_at":"2026-04-12","retrieved_at":"2026-08-09","excerpt":"Acme has raised a $20 million Series B..."}
```

For an unfound field:

```json
{"id":"E-002","field":"headcount.current","status":"unfound","retrieved_at":"2026-08-09","searched":["Crustdata company enrichment","Acme company site"],"note":"No current figure was returned."}
```

Found facts require `value`, source title, source URL, and retrieval date. `published_at` is separate and optional. Conflicting facts remain separate rows with `status: "conflicting"`; never average or choose one invisibly. An excerpt is at most 25 words and must actually support the value.

## Coverage check

Before drafting, map every research question to one or more evidence ids or to an explicit `unfound` row. Then scan every factual sentence in the dossier: if it cannot end with an evidence id, delete it or label it as a hypothesis. A source preview never receives an evidence id.
