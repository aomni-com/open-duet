import { Text } from 'react-email'

import { EmailShell, paragraphStyle, quietStyle } from './email-shell'

export const TRAIN_COMPLETE_SUBJECT = 'Your Duet training is ready'
export const TRAIN_COMPLETE_PREVIEW = 'Your latest training job has finished.'

export function TrainCompleteEmail({
  actionUrl,
  jobId,
  recipientName,
}: {
  actionUrl: string
  jobId: string
  recipientName?: string
}) {
  const greeting = recipientName?.trim() || 'there'
  return (
    <EmailShell
      preview={TRAIN_COMPLETE_PREVIEW}
      greeting={greeting}
      actionUrl={actionUrl}
      actionLabel="Review training"
      footer="This email was sent because training completed for your Duet workspace."
    >
      <Text style={paragraphStyle}>
        Your latest training job is complete and ready to review in Duet.
      </Text>
      <Text style={quietStyle}>Job: {jobId}</Text>
    </EmailShell>
  )
}
