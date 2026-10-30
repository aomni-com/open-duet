# Search Operators

The `query` parameter accepts X's advanced search syntax. Everything — dates, engagement floors, media filters — goes inside the query string; there are no separate parameters for them.

## Operators

| Operator                         | Effect                                        |
| -------------------------------- | --------------------------------------------- |
| `"exact phrase"`                 | Phrase match                                  |
| `a OR b`, `(a OR b) c`           | Alternation, grouped                          |
| `-term`, `-filter:x`             | Exclude                                       |
| `from:handle`, `to:handle`       | Author, recipient                             |
| `@handle`                        | Mentions of an account                        |
| `#hashtag`, `$TICKER`            | Hashtag, cashtag                              |
| `url:example.com`                | Links to a domain                             |
| `lang:en`                        | Language (ISO 639-1)                          |
| `since:YYYY-MM-DD`               | On or after a date                            |
| `until:YYYY-MM-DD`               | Before a date                                 |
| `min_faves:N`                    | At least N likes                              |
| `min_retweets:N`, `min_replies:N`| Engagement floors                             |
| `filter:media`, `:images`, `:videos`, `:links` | Has that content type          |
| `filter:replies`, `filter:quote`, `filter:nativeretweets` | Post type           |
| `filter:verified`, `filter:blue_verified` | Author status                        |
| `list:ID`                        | Members of a list                             |

## Patterns

**What resonated on a topic** — engagement floor plus originals only, ranked:

```
("prompt caching" OR "context window") min_faves:100 -filter:replies lang:en
```
with `type=Top`.

**Everything an account said about something:**

```
from:handle ("pricing" OR "roadmap") since:2026-01-01
```

**Complaints about a competitor** — the raw material for a support or product agent:

```
(@competitor OR "competitor") (broken OR "doesn't work" OR frustrating) -filter:replies
```

**Who is linking to a domain:**

```
url:example.com -filter:replies min_faves:5
```

## Choosing a floor

`min_faves:` is the highest-leverage operator on this API, because unfiltered results are mostly noise and every page costs a call. Scale it to the topic's volume: `min_faves:10` on a niche technical term, `min_faves:500` on a mainstream one. Start high and relax it if the result set comes back thin — that costs one call, where starting low and paging through noise costs many.

## Limits

`since:`/`until:` are date-granular, not time-granular. Deep historical crawls with `type=Latest` eventually stop returning cursors — that is X refusing to page further, not a bug, and a narrower query is the fix rather than a retry. The reply endpoint only works on top-level tweets, so replies-to-replies come from the thread endpoint instead.
