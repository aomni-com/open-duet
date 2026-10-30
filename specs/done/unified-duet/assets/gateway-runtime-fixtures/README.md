# Gateway runtime fixture evidence

The gateway consumes one desired runtime and activates one complete inventory.
These [gateway fixtures](../../../../../packages/gateway/src/gateway.test.ts) use the
canonical runtime fixture and the actual release manager, with the control-plane
HTTP edge synthetic. Ordinary authentication, file, skills, command and runner
coverage stays in the same owning file.

A matching candidate is still insufficient for activation while work is live or
rollout is paused. The fixtures prove that the previous cohort remains active,
that a complete failed/cancelled attempt can recover, and that new work is
admitted after cancellation. The public health diagnostic settles detached
update work before the live-turn assertion, so completing the turn cannot hide
an early activation. Deliberately forcing activation and omitting admission
release each makes the maintained test fail.

The [routing fixture](../../../../../packages/gateway/src/runner/routing-release.test.ts)
bundles the actual routing owner and uses the full runtime inventory to activate
it. Its controlled model requests retain the original alias during a held turn,
then reflect the new routing bytes after reconnect and resume in a nested cwd.

[The receipt](receipt.json) freezes the borrowed integration inputs and separates
test-owned changes from source changes owned by the main implementation. Native
compiled payload closure, API transport, image construction and fleet migration
retain their separate maintained gates. The obsolete gateway-only build grammar
test is replaced by the actual shared/API constructor inventory and joined build.
