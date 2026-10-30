'use client'

import { useState } from 'react'

import type { App } from '@repo/contract'

import { DriveFileIcon } from '../drive/drive-file-icon'
import { FileGlyph } from '../files/file-glyph'
import { monogram } from '../knowledge-map/monogram'
import type { AppDisplayStatus } from '../status/entity-status'

export function appDisplayName(app: Pick<App, 'name' | 'anchorPath'>): string {
  return app.name ?? app.anchorPath.split('/').at(-1)!
}

/**
 * An app's mark, from artwork that has already been resolved to a URL.
 *
 * The sibling below takes the contract's `App` and works the drive path out
 * for itself; this one is for callers holding a projection that did that
 * already — the knowledge map's `AppItem`, whose `icon` is a URL by the time
 * anything draws it. Both live here so the fallback stays one decision.
 *
 * The lettering is `monogram`, the ring's, rather than a second rule that
 * happens to agree: it drops digits and punctuation on purpose, so an app
 * called "S3" reads as `S` on both surfaces instead of `S3` on one and `S` on
 * the other.
 *
 * A plain `<img>` rather than `next/image`: these are third-party URLs off the
 * drive, which is the case the optimiser has to be told about host by host.
 */
export function AppAvatar({
  src,
  name,
  className,
}: {
  src?: string | undefined
  name: string
  className: string
}) {
  /* An icon that fails to load falls back to the monogram, which is the same
     thing an app with no icon at all gets. Without this the browser draws its own
     torn-page glyph — and it does that for every ordinary reason a file can be
     unreachable: deleted since the row was read, a grant that lapsed, an offline
     replica. A missing picture is not an error the reader can act on, so it
     should look like an app with no picture rather than like something broken. */
  const [failed, setFailed] = useState(false)
  if (src !== undefined && !failed)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={`${className} rounded-[30%] object-cover`}
      />
    )
  return (
    <span
      aria-hidden
      className={`${className} grid place-items-center rounded-[30%] bg-muted text-[0.5rem] font-semibold text-muted-foreground`}
    >
      {monogram(name)}
    </span>
  )
}

export function AppIcon({
  app,
  status,
  workspaceSlug,
  className,
}: {
  app: Pick<App, 'anchorPath' | 'icon' | 'updatedAt'>
  status: AppDisplayStatus
  workspaceSlug: string
  className: string
}) {
  return (
    <DriveFileIcon
      entity={app}
      workspaceSlug={workspaceSlug}
      className={`${className} rounded-md object-cover`}
      fallback={
        <span className={`${className} grid place-items-center`}>
          <FileGlyph
            entry={{ name: app.anchorPath.split('/').at(-1)!, isDirectory: true }}
            app={{ status }}
            className="size-full scale-125"
          />
        </span>
      }
    />
  )
}
