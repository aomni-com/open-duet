# @repo/typescript-config

`@repo/typescript-config` is the shared TypeScript baseline for the monorepo. It
keeps strict compiler defaults in one place so workspaces can extend the common
shape without each package inventing its own interpretation of "strict enough."

## Boundary

This package should stay boring. Put defaults here when they apply across the
repo; keep deployment-specific compiler workarounds in the workspace that needs
them, especially for Vercel function apps whose local checks and builder checks
do not run under identical compiler environments.

## Pointers

- `base.json` owns the default library, module, resolution, and strictness
  settings for ordinary TypeScript packages. **`lib` is Node-neutral (`["ESNext"]`,
  no `DOM`)** — the repo is Bun/Node services, so browser types are opt-in, not a
  default. Don't add `DOM` here: it would let a Node module reference `document`,
  `localStorage`, or a browser-only `fetch`/`Response` overload and type-check
  clean while failing at runtime. A Node file that legitimately needs a fetch type
  (`BodyInit`, `HeadersInit`) derives it from the ambient API (`RequestInit['body']`),
  not a `DOM` alias.
- `nextjs.json` adds `DOM`/`DOM.Iterable` — web is real browser code. Test files or
  HTTP-mocking infra that use Web-API types opt in the same way: a `tsconfig.check.json`
  that re-adds `DOM` for the check (see `apps/{api,mcp,model-gateway}` and
  `packages/gateway`), or DOM in a fixture package's own config (`@repo/test-harness`).
- `react-library.json` owns the JSX setting for React library-style packages.
