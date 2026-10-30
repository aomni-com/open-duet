# Reference mechanisms and pricing rationale

The design was grounded in agent 0.3.24's routing table, single-destination
router, active-tier transport, and complete-file loader. The inspected reference
checkout was `/Users/synthetic-user/dev/duet-agent`; these are historical research paths,
not dependencies of the archived spec. Duet's installed-agent runtime tests are
the durable proof of compatibility.

The reference chat app used durable model roles to preserve selection through
upgrades. Duet reuses that product promise through its existing virtual routes.
The agent's default effective context was 200,000 tokens, supporting the user's
compaction rationale. This feature does not add long-context price branches.

## Pricing research and superseded alternatives

The public [Vercel model catalog](https://ai-gateway.vercel.sh/v1/models),
[Astra page](https://vercel.com/ai-gateway/models/gpt-6-astra), and
[Fable page](https://vercel.com/ai-gateway/models/claude-fable-5.1) were inspected
on 2026-09-21. Standard input/output for both were $10/$50 per million;
Astra cached input was $1 and Fable cached input $0.25. Cache writes and
long-context/service variants are separate upstream charges. Thus $12/$60/$1.20
is a markup over standard base/read rates, not a guarantee of identical margin
on every possible upstream token category. Preserve the agreed fixed price;
do not silently change it during implementation.

The user rejected the proposed $30/$80/$5 worst-case price because the harness
compacts before higher context pricing. The user also rejected concrete version
names as persistent choices in favor of automatic upgrades, chose both selector
surfaces, fixed family pricing rather than pass-through, and explicit failure
rather than different-model fallback. None of these alternatives remains live.
