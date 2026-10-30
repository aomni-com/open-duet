# Settings domain inventory visual review

The target is the existing workspace Settings hierarchy with a readable paged
inventory: app name first, hostname and shared lifecycle state beneath it, then
Manage/View and explicit app navigation actions. Phone rows stack actions and
wrap long hostnames within the card. DNS styling remains owned by the shared
manager, rather than a separate Settings renderer.

The before images are earlier attempts and adjacent Settings precedent, not
approved designs. The native source captures remain in the web screenshot owner.
Contact sheets retain all inventory/error/loading/reader/locale states; the 2x
row/navigation crops support legibility review. Before/after members comparisons
isolate the added Settings entry. Pixel telemetry confirms that the current
internal-navigation icon reached the real renderer; equal viewport dimensions
and 450 changed pixels are expected for that small icon correction.

The focused Docker gate passed 44/44 across both viewports after the current
26 domain state images and 54 affected adjacent workspace navigation images were
captured. Force approval also ran the existing user-account Settings flow; its
unchanged API-key, not-payer, and profile-error baselines were restored. The
pre-existing desktop API-key/mobile not-payer failures remain reported separately,
with no assertion, skip, or tolerance changes.

The parent fresh review accepted the layouts, while identifying a clipped
desktop Open-error capture. That state now uses full-page framing, retaining the
complete toast; the mobile image was already complete and stays pixel-identical.
The corrected full shots, 2x toast crops, and framing telemetry are retained.
The final fresh review accepted both full captures and toast crops. Its concern
about the mobile toast covering part of a row was examined: the ordinary
dismissible overlay leaves dismissal and row actions reachable. The shared toast
owner was retained; no global toast styling change was needed. The unrelated failure images and final
receipt are retained under `unrelated/`.
