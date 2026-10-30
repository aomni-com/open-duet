// The single home for "what a Syncthing folder never syncs, and why." Both the
// whole-drive mirror (`../mirror`) and folder shares (`../shares`) compose their
// `.stignore` defaults from these groups, so the delicate parts are stated once
// and cannot drift between the two.

// The git-research verdict (research/syncthing-operations.md §C): a repo under
// two writers corrupts, and node_modules is wrong-arch across machines — so
// neither ever syncs, on a mirror or a share. `(?d)` lets Syncthing delete an
// already-ignored node_modules dir when nothing else keeps it. The modifier
// must abut its pattern with NO space (`(?d)**/node_modules`) — a space is
// taken as part of the pattern and silently defeats the match, leaking
// node_modules (verified against Syncthing v2.1.2).
export const VCS_AND_DEPS_IGNORE = ['**/.git', '(?d)**/node_modules'] as const

// Anchor markers are workspace-local identity. A share connects two different
// anchor identities at its roots, so neither side may transport its marker to
// the other. Keep this separate from VCS_AND_DEPS_IGNORE: whole-drive mirrors
// have one writer for marker identity and intentionally do not use this group.
// Syncthing's `**/name` glob does not match `name` at the folder root, so both
// forms are required; the live relocation probe pins that distinction.
export const ANCHOR_MARKER_IGNORE = ['.duet-anchor', '**/.duet-anchor'] as const

// Ignores that ONLY the whole-drive folder needs — not shared subtrees.
// `.duet` (the gateway's drive-local staging dir) and `.stfolder` /
// `.stversions` (Syncthing's own per-folder internals) all live at the DRIVE
// ROOT. The whole-drive mirror folder is rooted there, so it syncs them unless
// excluded here. A share is a SUBTREE mount — it is rooted at some folder
// under the drive and never contains these root-level paths, so its default
// deliberately omits this group. This is why the two defaults differ: not a
// policy difference, just a consequence of what each folder's root contains.
export const WHOLE_DRIVE_IGNORE = ['.duet', '.stfolder', '.stversions'] as const

// Note on `.env`: deliberately absent from every group here. A mirror is a
// personal replica (secrets travel), and shares treat `.env` as a normal file
// (ledger #14 — sometimes the user wants to share secrets, and synced env vars
// are what make shared apps run). Serving `.env` over HTTP stays blocked at the
// edge and gateway — syncing and serving are separate policies.
