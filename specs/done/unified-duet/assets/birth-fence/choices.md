# Birth-fence choices

- **Temporary configuration at admission.** VM attachment and resize admission pauses through one
  call-time backend setting, while agent work and workspace servicing continue.
  A permanent rollout lease or separate lifecycle controller would leave more
  machinery after the migration. The platform already makes environment reads
  part of mutation transactions, which is the barrier this operation needs.
- **Finish admitted provider work.** A create already running when the fence
  closes can record its result. Refusing at record would invoke the existing
  rollback path and could delete a VM that has started serving the workspace.
  The final inventory therefore drains admitted runs and their continuations.
- **Preserve recovery before waiting.** Subscription resume retains the existing
  backup pin while it waits. If an earlier teardown is already running, its
  existing attach-after intent is retained too; no new teardown starts behind
  the fence. Leaving either pin unprotected would allow deleting the next
  Drive’s recovery source without the existing warning.
- **Explicit replay through the existing owner.** Accepted births and subscription
  resumes remain in their existing provisioning state. The operator replays
  known deferred IDs after the new image is configured, rather than adding a
  recurring retry loop. Provisioning status alone is insufficient: intentionally
  unserviced historical rows use the same status and must stay untouched.
- **Reject fresh replacement requests atomically.** A new explicit reprovision
  or recovery request during the final cutover is temporarily refused before
  capture or VM credential changes. Already accepted recovery continues through
  its existing owner. This keeps original VMs intact without another intent
  schema for a short maintenance interval.

- **Fence existing reboot owners without adding another worker.** Disk resize
  already has a durable run ID; CPU and memory resizing already has platform
  cron execution state. The fence closes their existing admission points and
  the operator drains those existing observations. Redirecting both into a new
  worker framework would make a temporary rollout more complicated. The actual
  VM alignment performs no provider reboot, resize, or reprovision.

- **Replay only accepted disk upgrade requests.** Subscription events ordinarily
  trigger disk reconciliation once. If that event arrives while fenced, simply
  waiting for another event could withhold purchased capacity until renewal. A
  temporary explicit-payer mutation replays the existing policy after cutover
  for affected requests in the interval ledger. It intentionally applies that
  payer’s plan to its workspaces, as the normal billing owner does; it is not a
  migration resize pass, and runs zero times when no upgrades were accepted.
