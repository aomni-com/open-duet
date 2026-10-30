# Staging acceptance

The focused journey passed on staging revision `db4ecc84c` on 2026-10-06 UTC,
using the built standalone CLI and official MCP client. All four outputs were
nonempty with matching MIME, size and hash evidence, and every generation settled
at upstream cost. Native image/video each used the existing $2 hold; text and
language-image used direct services accounting.

[Receipt](receipt.json) contains the complete acceptance claims and verified
cleanup. The post-run list-only sweep found zero ephemeral VMs.

Earlier attempts are retained in [attempt history](attempt-history.json), because
retrying paid work must follow its actual outcome. The first run exposed an
oracle that wrongly rejected `services` attribution. A later Seedance request
returned HTTP 400 on the selected controls and released its hold; that candidate
is excluded from acceptance selection without changing production discovery.
Grok video exposed the SDK downloader's missing dynamic runtime dependency.
A manifest declaration alone did not put the module into the standalone function;
packaging now includes it and an isolated native Node artifact check pins that.

One earlier Grok video incurred $0.02 but became `charge_failed` after its
fixture payer was deleted before settlement. The journey now waits for settled
or released accounting before teardown even when output fails. That earlier
fixture row is not claimed as successfully reconciled. The final four-request
acceptance cost $0.061099; observed upstream costs across all attempts totaled
$0.122483, including that earlier $0.02. No paid request retried automatically.

Local gates: full build, types and lint passed. The full test run completed
25 of 26 tasks successfully; its obsolete routing-release fixture was repaired
and the entire affected gateway package then passed (1,380 passed, two skipped).
Shared visual coverage/owner union and asset ownership passed separately.
[Captured terminal verification](verification.json) retains the gateway repair,
ownership gates, deployment identity and post-run sweep. Whole-feature review
and final packaging/accounting review were completed;
findings were corrected with affected red/green checks.

This receipt proves the sampled deployed models, not every provider's response
shape. Upstream capability metadata can describe request modes a provider later
refuses. Output success remains separate from actual-cost reconciliation.
