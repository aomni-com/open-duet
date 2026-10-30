import type { App } from '@repo/contract'

/* ============================================================================
   What the reader may do to one app, and nothing about how it looks.

   Pure, because the rule is the interesting part: an app's controls are
   projected by the API from the caller's role *and* from how the app arrived —
   a shared replica lives in the recipient's own workspace, where they are the
   owner, and is still none of their business to publish or delete. Reading
   `controls` rather than re-deriving that from a role is what keeps this menu
   from offering an action the server would refuse.
   ========================================================================= */

export type AppMenuItem =
  /** the clean public address, in a tab of its own */
  | { kind: 'open-in-new-tab'; url: string }
  | { kind: 'copy-link'; url: string }
  | { kind: 'publish' }
  | { kind: 'make-private' }
  | { kind: 'custom-domains' }
  | { kind: 'delete' }

export function appMenuItems(app: App): AppMenuItem[] {
  const items: AppMenuItem[] = []
  /* These links offer public sharing; a private app keeps that invitation out
     of its menu. A broken app has no working public content to offer either.
     Its local domain remains inspectable and removable in either case. */
  if (app.visibility === 'public' && app.anchorState !== 'broken') {
    items.push({ kind: 'open-in-new-tab', url: app.canonicalUrl })
    items.push({ kind: 'copy-link', url: app.canonicalUrl })
    if (app.controls.makePrivate) items.push({ kind: 'make-private' })
  } else if (app.controls.makePublic) {
    items.push({ kind: 'publish' })
  }
  items.push({ kind: 'custom-domains' })
  if (app.controls.delete) items.push({ kind: 'delete' })
  return items
}
