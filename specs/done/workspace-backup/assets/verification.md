# Workspace backup verification

2026-09-29, isolated `codex/workspace-backup` checkout. No production rollout or
customer-data export was performed.

## Local checks

The repository-wide closeout run passed 22 of 23 package test tasks. Backend
integration required a follow-up package run: 1,574 passed and five failed across
1,579 tests in 136 files. The final fixture correction and retry correction were
integrated while that long-running process retained earlier modules, so three
failures reflected superseded code. Two unrelated integration cases hit Convex's
one-second execution deadline. Final-code focused reruns passed all five:
50 fixture/lifecycle/census checks, the app-replica update, and concurrent API
budget accounting. The complete repository command was not reported as one
uninterrupted green run.

All workspace type and lint tasks passed. The global visual-owner, screenshot
union, and asset-integrity checks passed. [Settings verification](settings-review.md)
records browser interactions, regression images, and independent visual critique.
The final archive README edit also passed the gateway archive suite.

Whole-feature independent review and the subsequent focused reviews were applied
before deployment. The final reconciliation checked the spec's decisions as well
as its slice list; it corrected the recovery guidance to distinguish an unset
onboarding purpose from a generally editable workspace setting.

## Transfer and format boundaries

[Provider evidence](blob-proof.md) proves private direct multipart transfer above
1 GiB and the selected 500 MiB maximum part on the exact Linux Bun 1.4.2 gateway
runtime. Independent download hashes, range requests, signed authority, and
completed-object deletion passed. Hidden unfinished multipart reclamation remains
unverified.

[ZIP64 evidence](archive-zip64-linux.txt) covers a logical file beyond 4 GiB and
more than 65,535 entries with independent extraction. [Decoder evidence](restore-decoder-memory.md)
records entry-count memory cost. These are boundary probes, separate from the
small disposable live journey.

## Live acceptance

The first live run stopped during fixture setup because an app cannot reuse an
agent's anchor folder. The fixture now uses its own app folder, including in the
archive evidence and fresh-workspace copy. Its focused tests, types, lint, and
independent review passed. That failed run cleaned its user, workspace, VM, mail,
and agent with no orphans. No production behavior was changed for that correction.

Staging uses API deployment `service.example.invalid`, gateway release
`0.0.0+5b81869024f8`, and verified image
`ghcr.io/aomni-com/duet-vm-image@sha256:ae2bbe4980b9a06ea4a0032db0897fe964c56cceb3d3dd9f43248ff1fbe24826`.
The image digest was independently read back from Convex after configuration.
Vercel's sensitive environment values are intentionally blank in readback; their
blank strings are not evidence of absent deployed configuration.

The corrected `workspace-backup` run passed with exit code 0. Its
[sanitized receipt](live-backup-evidence.json) records the complete archive's
335,430 bytes, SHA-256, 45 files, 282 portable records, and a 260-event fixture
ceiling. Exact hidden/ignored/cache/dependency/binary bytes, executable mode,
empty directory, symlink targets, archived/hidden/child history, and attachment
bytes passed independent ZIP inspection. A synthetic FIFO produced the expected
`unsupported_node` partial warning rather than disappearing silently.

Settings creation, navigation away/return, and browser download passed. Replacement
changed the VM credential generation and restored the fixture bytes. The original
export remained downloadable afterward. Fresh-workspace birth and recreation of
representative files, agent/app registrations, and an ID-remapped integration
policy passed through existing APIs. Deletion refused new download admission and
returned 404 for the uncached old object URL. Cleanup deleted all eight recorded
resources with no orphans.

## Independent recovery and visual review

A fresh reviewer received only the [extracted README](live-recovery-README.md) and
[selected synthetic records](live-recovery-fixture.json), without implementation
or conversation context. It derived the correct public agent/app registration
and policy operations from current docs, mapped the old agent ID to a new ID,
and distinguished historical conversations, conditional onboarding purpose,
reconnect-required OAuth, and excluded authority. It did not invent native chat
import or replay histories. The live journey separately executed representative
recreation; the review itself made no service writes.

The README deliberately depends on current API discovery: portable records are
not request bodies, and the recipient must reconcile slugs and translate source
IDs. The reviewer recommended more worked examples and post-recovery checks;
those are optional guidance improvements, not an additional restore contract.

The [live Settings frame](live-backups-settings.png) and [2× card crop](live-backups-card-2x.png)
show both complete and partial results. The target was legible statuses, distinct
row actions, and a warning visibly attached to the partial capture. An unprimed
reviewer and the parent found no clipping, overlap, crowded controls, or unreadable
warning. Mobile behavior remains covered by the earlier deterministic visual gate.

The [aligned comparison](live-settings-comparison.png) uses the existing empty
Settings fixture as its visual reference. Viewport and data differ; the preserved
896-pixel card width and [metrics](live-settings-metrics.json) are diagnostic, not
a pixel-regression verdict. The changed 10,393 pixels (3.314% of the aligned crop)
show populated rows and warnings. The live candidate meets the stated target.

## Closed rationale audit

Two fresh reviewers checked every substantive statement of the final rationale
against code, tests, and retained evidence. Corrections narrowed finite-read
claims to files/history, distinguished recoverable omissions from capture failure,
and corrected a visual pointer description. Re-audits confirmed the revised claims.
