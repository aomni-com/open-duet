'use client'

import { createContext, useContext, type ReactNode } from 'react'

import { findMemberIn, HARBOR, type TeamWorkspace, type TeamMember } from './team-space-fixture'

/**
 * Which workspace the surface below is drawing.
 *
 * A context rather than a prop because the deepest thing that needs it is a
 * mention chip inside a message inside a transcript — and threading a workspace
 * through five layers so one span can resolve a name is how a prop becomes
 * noise. The provider is the playground entry; nothing under it may change the
 * value, which is what keeps this a fixture rather than a store.
 */
const WorkspaceContext = createContext<TeamWorkspace>(HARBOR)

export function TeamSpaceWorkspaceProvider({
  workspace,
  children,
}: {
  workspace: TeamWorkspace
  children: ReactNode
}) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): TeamWorkspace {
  return useContext(WorkspaceContext)
}

/** One member of the workspace in scope, by id. */
export function useMember(id: string | undefined): TeamMember | undefined {
  const workspace = useWorkspace()
  return id === undefined ? undefined : findMemberIn(workspace, id)
}
