# Runtime admin choices

The fleet and VM health read their canonical runtime fields directly. No gateway/agent/duetfs aliases survive in the current browser transport or fixtures. VM health reads the status report so a newly running release is not hidden by an older workspace summary. Gateway reachability and service-specific log selection remain because they describe operations inside the runtime rather than independent release identities. Image provenance and historical audit facts retain their existing ownership.

The existing fleet table stays in place. Its four metrics use one runtime tally, and rows lose a redundant component column. The localized metric counts reported build identities; it does not place a long hash in a metric card, including when only one build remains. The producer excludes unreported identities from this tally while retaining optional unknown VM rows. That backend fix is owned separately in 1ccc4f1f5; the browser adds no filter or compatibility adapter.

Full 70-character identities remain in the table without truncation and wrap in VM health. Narrow screens retain native horizontal scrolling with a visible cue and keyboard focus rather than adding another mobile data model. The browser journey proves scrolling and restores the initial position after the actual completion event; capture timing does not decide which workspace names are visible. A Docker-native selection and copy probe confirms the literal complete value. CPU units receive a real layout gap so values and percentages remain distinct.

No cache migration is needed: query-persistence.ts excludes internal-admin queries from persistent storage. The canonical schema snapshot is borrowed from birth_fence (5826d261b) for local verification and is excluded from this UI commit.

The scrolled ending must still identify its VM. The existing first column and header now stick to the scroll region with the same opaque panel background. The owning browser test checks label geometry and hit testing at the actual runtime ending; no new table model or truncated identity is introduced.

The Runtime heading itself must remain identifiable while reading the ending. Its single label aligns to the existing column’s right edge and sticks inside the scroll viewport. This avoids duplicate labels or assumptions about workspace-column width; values remain unchanged. The browser tracer measures actual header text beside the visible workspace column.
