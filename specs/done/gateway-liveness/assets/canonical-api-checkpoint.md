# Canonical activity API checkpoint

The focused real-boundary gate is:

```text
bun test src/routes/file-activity.test.ts -t 'real API checkpoint'
1 pass, 0 fail
```

It creates and writes `old.md`, renames it to `new.md`, writes again, and fetches
`new.md` through the authenticated REST route. The returned page is newest-first:

```text
fa sequence 4  write   new.md
fa sequence 3  rename  new.md (from old.md)
fa sequence 2  write   old.md
fa sequence 1  create  old.md
```

The same checkpoint creates, deletes, and recreates `copy.md`, then reuses
`old.md`; each selected live path returns only its new identity's row. Exact history
reports four indexed reads for the one-segment path: namespace row, active binding,
entity-event page, and restore page. Rename-chain length does not add a read.
