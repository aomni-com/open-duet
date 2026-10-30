# Runtime harness consumer proof

The [receipt](receipt.json) records source-controlled acceptance of the runtime
wire shape. The [consumption owner](../../../../../packages/test-harness/src/staging-e2e-synthetic)
validates a complete shared-schema manifest and its canonical identity before
journeys compare process health or workspace diagnostics. It fetches metadata;
it does not construct, rebuild, or independently publish runtime artifacts.

The workspace adapter names a temporary fleet boundary: the backend's historical
gateway diagnostic carries the runtime identity during slice 06. Slice 10 owns
removing this mapping when storage and the fleet have migrated. Journey code
sees one runtime identity and does not select npm component versions.

The existing model-refresh script now checks the physical executable selected
by PATH against the announced CLI artifact before issuing any command. This
makes a stale launcher fail honestly. Bootstrap and image work must converge
PATH as well as the running gateway's captured absolute executable.

These gates exercise loopback HTTP, controlled query responses, fake executable
bytes, and bounded polling. No paid model, live workspace, full suite, or new
staging journey ran. Root integration still owes a joined artifact/native gate
and the old-API bootstrap, recovery, and fleet census before server promotion.
