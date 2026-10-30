import type { WorkspaceInvite, WorkspaceMember } from '@repo/contract'

/**
 * One roster row: a person who is in the workspace, or a person who has been
 * asked and has not answered yet. Both are "who is in this workspace" as far
 * as the reader is concerned, which is why they share a list and a row shape.
 */
export type WorkspaceRosterRow =
  | { kind: 'member'; id: string; member: WorkspaceMember }
  | { kind: 'invited'; id: string; invite: WorkspaceInvite }

export function projectWorkspaceRoster(input: {
  members: readonly WorkspaceMember[]
  invites: readonly WorkspaceInvite[]
  now: number
}): WorkspaceRosterRow[] {
  /* Nothing stops an owner inviting somebody who is already here, and the
     invite then sits open for its whole week because that person has no reason
     to redeem it. Two pages could never show that; one list would show the
     same human twice, the second time as somebody still deciding. The address
     is the identity here — an invite names an email, not a user id — so the
     comparison is on a case-folded address, which is the form the backend
     already stores invites in. */
  const present = new Set(input.members.map(member => member.email.trim().toLowerCase()))
  return [
    ...input.members.map(
      (member): WorkspaceRosterRow => ({ kind: 'member', id: member.id, member }),
    ),
    ...input.invites
      .filter(
        invite =>
          isOpenInvite(invite, input.now) && !present.has(invite.email.trim().toLowerCase()),
      )
      .map((invite): WorkspaceRosterRow => ({ kind: 'invited', id: invite.id, invite })),
  ]
}

/**
 * The invite list is a history — the browser keeps the bounded pages the owner
 * explicitly loaded, and only one row state means "still waiting on them".
 * Expiry counts as an answer even though nobody gave one: an expired token
 * cannot be redeemed, so a row for it would promise access that the accept
 * path already refuses. Re-inviting the same address is the way back, and the
 * backend treats an expired invite as inactive so that path stays open.
 */
function isOpenInvite(invite: WorkspaceInvite, now: number): boolean {
  return invite.revokedAt === undefined && invite.consumedAt === undefined && invite.expiresAt > now
}
