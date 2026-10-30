'use client'

import { useParams } from 'react-router'

import { WorkspaceDesktop } from '../desktop/workspace-desktop'

export default function DesktopRoute() {
  const { workspaceSlug = '' } = useParams()
  return (
    <div className="flex h-full min-h-0 p-3">
      <WorkspaceDesktop workspaceSlug={workspaceSlug} />
    </div>
  )
}
