import type { ReactElement } from 'react'

import {
  AUTH_MAGIC_LINK_PREVIEW,
  AUTH_MAGIC_LINK_SUBJECT,
  AuthMagicLinkEmail,
} from './auth-magic-link'
import type { TransactionalEmailInput, TransactionalEmailKind } from './contracts'
import { SHARE_INVITE_PREVIEW, ShareInviteEmail, shareInviteSubject } from './share-invite'
import {
  TRAIN_COMPLETE_PREVIEW,
  TRAIN_COMPLETE_SUBJECT,
  TrainCompleteEmail,
} from './train-complete'
import {
  WORKSPACE_INVITE_PREVIEW,
  WORKSPACE_INVITE_SUBJECT,
  WorkspaceInviteEmail,
} from './workspace-invite'

export type PreparedTransactionalEmail = {
  kind: TransactionalEmailKind
  subject: string
  preview: string
  document: ReactElement
}

export function prepareTransactionalEmail(
  input: TransactionalEmailInput,
): PreparedTransactionalEmail {
  switch (input.kind) {
    case 'auth_magic_link':
      return {
        kind: input.kind,
        subject: AUTH_MAGIC_LINK_SUBJECT,
        preview: AUTH_MAGIC_LINK_PREVIEW,
        document: (
          <AuthMagicLinkEmail
            actionUrl={input.actionUrl}
            {...(input.code === undefined ? {} : { code: input.code })}
            {...(input.clientName === undefined ? {} : { clientName: input.clientName })}
            {...(input.expiresInMinutes === undefined
              ? {}
              : { expiresInMinutes: input.expiresInMinutes })}
          />
        ),
      }
    case 'workspace_invite':
      return {
        kind: input.kind,
        subject: WORKSPACE_INVITE_SUBJECT,
        preview: WORKSPACE_INVITE_PREVIEW,
        document: <WorkspaceInviteEmail actionUrl={input.actionUrl} role={input.role} />,
      }
    case 'share_invite':
      return {
        kind: input.kind,
        subject: shareInviteSubject(input),
        preview: SHARE_INVITE_PREVIEW,
        document: (
          <ShareInviteEmail
            actionUrl={input.actionUrl}
            sharerName={input.sharerName}
            folderName={input.folderName}
          />
        ),
      }
    case 'train_complete':
      return {
        kind: input.kind,
        subject: TRAIN_COMPLETE_SUBJECT,
        preview: TRAIN_COMPLETE_PREVIEW,
        document: (
          <TrainCompleteEmail
            actionUrl={input.actionUrl}
            jobId={input.jobId}
            {...(input.recipientName === undefined ? {} : { recipientName: input.recipientName })}
          />
        ),
      }
  }
}
