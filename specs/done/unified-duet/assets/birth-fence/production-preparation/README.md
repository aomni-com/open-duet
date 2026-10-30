# Production-compatible lifecycle fence preparation

This checkout keeps production's exact old schema, generated ABI, contract and
frozen dependency lock. Only the eight previously reviewed fence sources differ
from `dbb28fe14a026c143f2134b88586a13f2e0ebdef`. Every patched byte matches the
[parent receipt](../receipt.json); no strict unified-runtime source is adopted.

The clean source commit is `f728ae9c07f710e2be5fb02b92dbb8d57d653350` in
`/tmp/unified-duet-compatible-production-backend`. A separate deploy checkout at
`/tmp/unified-duet-compatible-production-deploy` contains only the existing rail's
generated deployment revision on top of that source. Its package-local compiler
link resolves to the checkout's exact frozen hoisted compiler. This separates
reviewable source from the generated deployment artifact without changing tools
or application ABI.

`receipt.json` binds source, patch, unchanged ABI, compiler placement and local
verification. It supplies the operator's exact deploy command but does not execute
it. Production deployment, admission closure, drain observation and VM alignment
remain separate root-owned steps after staging acceptance. No live dry-run,
configuration edit, deployment, VM operation or GitHub push occurred here.
