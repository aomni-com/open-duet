import { Text } from 'react-email'

import { EmailShell, paragraphStyle } from './email-shell'

export const SHARE_INVITE_PREVIEW = 'Open the folder and start working together.'

export function shareInviteSubject({
  sharerName,
  folderName,
}: {
  sharerName: string
  folderName: string
}) {
  return `${sharerName} shared “${folderName}” with you`
}

export function ShareInviteEmail({
  actionUrl,
  sharerName,
  folderName,
}: {
  actionUrl: string
  sharerName: string
  folderName: string
}) {
  return (
    <EmailShell
      preview={SHARE_INVITE_PREVIEW}
      greeting="there"
      actionUrl={actionUrl}
      actionLabel="Open shared folder"
      footer={
        <>
          {sharerName} sent the “{folderName}” folder to this address through Duet.
        </>
      }
    >
      <Text style={paragraphStyle}>
        {sharerName} shared the “{folderName}” folder with you.
      </Text>
      <Text style={paragraphStyle}>
        Open it in Duet to review the files and start working together.
      </Text>
    </EmailShell>
  )
}
