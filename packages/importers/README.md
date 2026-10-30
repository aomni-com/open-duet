# @repo/importers

`@repo/importers` turns local agent transcript stores into Duet memory snippets.
It understands a small set of transcript formats, extracts conversational text,
quarantines unknown shapes as warnings, and scrubs secrets before snippets become
memory input.

## Boundary

Importers are best-effort readers of user-local history. They should never be a
hard dependency for normal workspace operation, and they should fail softly per
source so one malformed transcript does not block the rest of an import.

Secret handling belongs at this boundary because imported transcripts often
contain credentials copied from terminals or tool logs. The redaction rules live
in [`@repo/contract`](../contract/README.md) so other ingestion paths use the
same masks.

## Pointers

- `src/index.ts` owns source selection, transcript walking, parser adapters,
  warning collection, and redaction handoff.
- Add a new importer here only when it reads a local transcript source and emits
  the shared snippet shape.
