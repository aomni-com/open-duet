# Hello tasks

This small task list is a sample app that came with your Duet workspace. It is a
real one, not a mockup: it has an HTTP API, saves its own data, and updates every
open page when a task is added.

It is here as an example, so it is yours to change or delete — nothing depends on
it. You never have to start from this one either: ask Duet in chat for the app
you actually want, and it builds it, runs it, and hosts it in this workspace the
same way.

## Run it

```sh
bun run server.ts
```

Duet assigns a port when it runs the app. From another process in the same
workspace, call it over loopback at `http://127.0.0.1:$PORT`.

## API

- `GET /api/tasks` returns `{ "tasks": Task[] }`.
- `POST /api/tasks` accepts `{ "title": string }` and returns
  `201 { "task": Task }`.
- `GET /events` is the server-sent event stream used by the page.

A task has the shape
`{ "id": string, "title": string, "createdAt": number }`. Titles must contain
1–160 characters after surrounding whitespace is removed.

For example:

```sh
curl -X POST "http://127.0.0.1:$PORT/api/tasks" \
  -H 'content-type: application/json' \
  -d '{"title":"Read the starter app"}'
```

Changing tasks and changing this app are different jobs. To add or read task
data, call the API. To change how the service behaves or how the page looks,
edit `server.ts` or `page.html`.

## Storage

The first successful POST creates `tasks.json`; starting the server or reading
an empty list creates no data file. Each update replaces that JSON file
atomically before notifying open pages, so an event never announces data that
was not saved.

This example deliberately uses atomic JSON rather than SQLite. The app folder
is synchronized to your devices, and SQLite journal, WAL, and shared-memory
sidecars would churn in that replicated folder and could arrive torn. Atomic
JSON keeps the first example readable and gives synchronization one complete
file per committed change.
