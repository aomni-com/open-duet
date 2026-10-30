import { Text } from 'react-email'

import { EmailShell, paragraphStyle } from './email-shell'

export const WORKSPACE_INVITE_SUBJECT = "You're invited to a Duet workspace"
export const WORKSPACE_INVITE_PREVIEW = 'Join your team and start collaborating in Duet.'

export function WorkspaceInviteEmail({
  actionUrl,
  role,
}: {
  actionUrl: string
  role: 'editor' | 'viewer'
}) {
  const article = role === 'editor' ? 'an' : 'a'
  return (
    <EmailShell
      preview={WORKSPACE_INVITE_PREVIEW}
      greeting="there"
      actionUrl={actionUrl}
      actionLabel="Accept invitation"
      footer="This address was invited to a Duet workspace. If you weren't expecting this invitation, you can safely ignore this email."
    >
      <Text style={paragraphStyle}>
        You’ve been invited to collaborate in a Duet workspace as {article} {role}.
      </Text>
      <Text style={paragraphStyle}>
        Accept the invitation to join your team and start working together.
      </Text>
    </EmailShell>
  )
}
