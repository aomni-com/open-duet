# Stable namespace transcript

Run from `packages/backend`:

```sh
bun test src/file-activity-namespace.test.ts -t 'prints the deterministic namespace transcript'
```

Stable aliases replace database-generated IDs. The fixture prints:

```json
{
  "beforeRename": { "a": { "entity": "E1", "historical": false, "epoch": 1 } },
  "afterRename": {
    "a": { "entity": "E1", "historical": true, "epoch": 1 },
    "b": { "entity": "E1", "historical": false, "epoch": 1 }
  },
  "afterOverwrite": {
    "destination": { "entity": "E1", "historical": false, "epoch": 1 }
  },
  "afterCopyAndReuse": {
    "copy": { "entity": "E3", "historical": false, "epoch": 1 },
    "reusedA": { "entity": "E4", "historical": false, "epoch": 1 }
  },
  "afterMove": {
    "oldAlias": { "entity": "E5", "historical": true, "epoch": 1 },
    "current": { "entity": "E5", "historical": false, "epoch": 1 },
    "sameDescendant": true
  },
  "afterRestore": {
    "preRestoreAlias": null,
    "destination": { "entity": "E6", "historical": false, "epoch": 2 }
  },
  "folderMoveBindingWrites": {
    "descendants0": 2,
    "descendants10": 2,
    "descendants100000": 2
  }
}
```

The descendant labels are workload sizes, not enumerated inputs to the move. The
transition accepts only the moved folder's source and destination slots, and its
counter therefore stays at one ended plus one opened binding for every size.
