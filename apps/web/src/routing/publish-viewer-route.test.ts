import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// The public publish viewer must be provably unauthenticated. These pins guard
// the two ways that can regress: routing (the middleware would gate it) and the
// direct module imports (an auth/session import would drag a session into the page).

const APP_DIR = path.resolve(import.meta.dir, '../../app')
const SPA_DIR = path.resolve(import.meta.dir, '../../spa')
const PUBLISH_ROUTE_DIR = path.join(APP_DIR, 'publish/[workspaceSlug]/[publishSlug]/[[...path]]')
const VIEWER_MOUNT = path.join(SPA_DIR, 'publish/publish-viewer.tsx')
const VIEWER_SHELL = path.join(SPA_DIR, 'publish/publish-viewer-shell.tsx')
const VIEWER_CONTROLLER = path.join(SPA_DIR, 'publish/publish-viewer-controller.ts')

function importLinesOf(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line))
}

describe('public publish viewer route', () => {
  test('lives outside the (product) route group that mounts AuthProvider', () => {
    // `(product)` is the only group with a layout that wraps children in
    // AuthProvider; the publish route is a sibling of it, not inside it.
    expect(readdirSync(APP_DIR)).toContain('publish')
    expect(readdirSync(APP_DIR)).toContain('(product)')
    expect(readdirSync(PUBLISH_ROUTE_DIR)).toContain('page.tsx')
  })

  test('page source has no direct auth, session, or AuthProvider import', () => {
    const forbidden = /auth|session|AuthProvider|convex/i
    expect(
      importLinesOf(path.join(PUBLISH_ROUTE_DIR, 'page.tsx')).filter(l => forbidden.test(l)),
    ).toEqual([])
  })

  // The viewer's mount, shell and URL/path controller must
  // be as credential-free as the page: an authenticated import here is the one
  // way a session could ride a hostile `duet_session` cookie into the viewer.
  test('the three client viewer sources have no direct auth/session/api-client import', () => {
    // A published viewer talks to the network only through the anonymous,
    // credentials-omit PublicFileSystemProvider — never the authenticated REST
    // client, React Query, or any auth/session/convex module.
    const forbidden =
      /auth|session|AuthProvider|convex|spa\/api|duetApi|DuetApi|rest-provider|RestFileSystemProvider|react-query|useQuery/i
    for (const file of [VIEWER_MOUNT, VIEWER_SHELL, VIEWER_CONTROLLER]) {
      expect(importLinesOf(file).filter(line => forbidden.test(line))).toEqual([])
    }
  })

  test('viewer sources name the anonymous provider and shared read-only modes', () => {
    // The single seam that could quietly re-authenticate the viewer is swapping
    // the provider or dropping the read-only mode; pin both. The mount owns the
    // anonymous provider; the shell owns the read-only Drive/preview modes.
    expect(readFileSync(VIEWER_MOUNT, 'utf8')).toContain('PublicFileSystemProvider')
    const shell = readFileSync(VIEWER_SHELL, 'utf8')
    expect(shell).toContain("mode: 'public'")
    expect(shell).toContain('READONLY_SOURCE_PREVIEW_MODE')
  })

  test('page source names the edge descriptor parser and contains no cookie call', () => {
    // The page's only trusted input is the edge-injected descriptor header,
    // parsed through the shared @repo/contract parser (which returns null for a
    // missing/malformed header). Pin that it reads that header via that parser
    // and never touches a cookie/session. The null→not-found branch itself is
    // covered behaviorally by the parser's own contract tests; a server-page
    // render harness that runs effects does not exist in this repo.
    const page = readFileSync(path.join(PUBLISH_ROUTE_DIR, 'page.tsx'), 'utf8')
    expect(page).toContain('parseViewerDescriptor')
    expect(page).toContain('DUET_VIEWER_DESCRIPTOR_HEADER')
    expect(page).not.toMatch(/cookies?\(/)
  })
})
