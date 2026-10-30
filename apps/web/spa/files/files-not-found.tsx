'use client'

import { FolderOpenIcon } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'

import { WorkspaceEmptyState } from '../drive/workspace-page'

export function FilesNotFound(props: {
  /** The single stale-link recovery action. The caller owns the parent-path calculation. */
  onOpenParent(): void
}): ReactNode {
  const t = useTranslations('duetApp.filesSurface.notFound')

  return (
    <div data-files-not-found>
      <WorkspaceEmptyState
        className="min-h-80"
        icon={<FolderOpenIcon />}
        title={t('title')}
        body={t('body')}
        action={
          <Button data-files-open-parent variant="outline" onClick={props.onOpenParent}>
            {t('openParent')}
          </Button>
        }
      />
    </div>
  )
}
