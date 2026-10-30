# Human login and synced Mac UI evidence

The account interface separates a person’s login from the computer mirroring
files. Removing one computer preserves the login and other computers; current
workspace membership determines what that login can do. The production owners
live in [web authentication](../../../../../apps/web/components/auth) and
[account settings](../../../../../apps/web/spa/routes/user-settings.tsx).

The [choices ledger](choices.md) records discretionary product decisions, and the
[review receipt](review.md) records the completed local gates and their limits.
Historical screenshots are comparison evidence rather than design requirements:
the old mobile login overflowed its viewport, and its grant controls no longer
represent the human-login contract.

[Desktop comparisons](comparisons/desktop/report/visual-parity-diff.json) and
[mobile comparisons](comparisons/mobile/report/visual-parity-diff.json) pair
historical and candidate crops with diagnostic metrics. Their side-by-side PNGs
preserve both candidates; crop limits are stated in the receipt. The final full
captures remain with the [web visual tests](../../../../../apps/web/tests/visual/__screenshots__).

Files attribution uses the backend’s physical actor classification and current
member directory. Sync and mirror labels name their kind without issuing a
machine/share lookup request or maintaining another UI registry. The cleanup
receipt is included in [the review](review.md#attribution-cleanup).
