'use client'

/* ============================================================================
   The drive, opened on an agent.

   ---- it starts where the agent lives, not at the root ----
   Every agent keeps its work in one folder, and that folder is what the reader
   means when they pick Files on an agent's card. Opening at the root and asking
   them to walk down to it would make the selector a link to the drive rather
   than a view of *this agent* — and the row it sits in is a row of that agent's
   own faces.

   It is a starting point and not a cage: the drive's own navigation is
   untouched, so walking up out of the agent's folder to the root and around the
   rest of the drive works exactly as it does on the drive's own page. The only
   thing this changes is where you come in.

   ---- and the walking has an address ----
   A file or folder is a subject somebody can link to, including the agent in
   the conversation beside this card. Navigation therefore stays on the same
   agent surface but writes the exact Drive path into that surface's URL.
   ========================================================================= */
import { useNavigate } from 'react-router'

import { agentsMapUrl } from '../../drive/agents-map-url'
import { WorkspaceDrive } from '../../files/workspace-drive'

export function AgentDrive({
  workspaceSlug,
  agentSlug,
  path,
}: {
  workspaceSlug: string
  agentSlug: string
  /** Exact browser path from an agent-scoped Files deep link. */
  path: string
}) {
  const navigate = useNavigate()

  /* ---- and the chrome comes down to size ----
     On its own page the drive is the page, and its strip can spend a whole row
     on nine controls. Here it is one of four views of an agent, sharing a card
     with a conversation — so the trail stays, the search stays, and everything
     else folds behind one mark. The reader came to look at *this agent's*
     files, not to run a file manager.

     Passed rather than sensed: the drive does not get to guess how much room it
     has, because a component that measures its own container answers a
     different question every time somebody resizes a pane. */
  return (
    <WorkspaceDrive
      workspaceSlug={workspaceSlug}
      path={path}
      onNavigate={(next, options) =>
        navigate(
          agentsMapUrl(workspaceSlug, {
            kind: 'agent',
            agentSlug,
            card: { kind: 'files', path: next },
          }),
          { replace: options?.replace ?? false },
        )
      }
      chrome="inline"
    />
  )
}
