# Domain management visual review

The target is an actionable single-domain dialog in Duet's existing dialog style:
DNS record name and value are distinct, long values wrap at phone width, and
connection/cleanup states always explain which address serves and which action
remains available. The earlier images are prior attempts, not approved designs.

Production captures live in the web screenshot owner under
`apps/web/tests/visual/__screenshots__/`. The state contact sheets here allow a
quick scan; the long-record zooms retain the legibility check. Before/after pairs
compare the same viewport and state: the existing private app menu gained the
inspection entry, and the first DNS panel gained explicit field labels and clearer
waiting copy. `comparison.json` records dimensions and confirms changed bytes;
height changes are expected consequences of the added actionable content rather
than pixel-distance failures.

The focused browser journey exercises the REST client and production dialog,
including the accepted slot, primary-address refresh, removal fallback, read-only
menu inspection, and manual cleanup retry. The exact Docker gate includes that
journey, its static fixture, and the affected existing app-menu journey. The
coverage ledger remains symbol-exact; screenshots and code ship together.

The first fresh critique found weak error/button contrast; the current domain
shots use darker destructive colors. The initial fixture's invented English reasons were replaced with the real adapter
wire: the ownership note `pending-ownership`, and no CNAME routing note.
Provider-supplied DNS reasons remain source text. UI-owned labels and
instructions are localized.

The final fresh critique inspected all 36 exact desktop/mobile source shots,
contact sheets and enlarged long-record captures. It accepted the candidate with
high confidence and no actionable layout, overflow, truncation, contrast or
hierarchy defects; parent inspection agreed. The later
[Recheck correction](recheck/README.md) retains its separate critiques and action
status checks. Final integrated gates are recorded in the
[live closeout receipt](../../live/README.md#local-gates-and-limits).
