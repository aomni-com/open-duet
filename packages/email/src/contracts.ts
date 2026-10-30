export const TRANSACTIONAL_EMAIL_KINDS = [
  'auth_magic_link',
  'workspace_invite',
  'share_invite',
  'train_complete',
] as const

export type TransactionalEmailKind = (typeof TRANSACTIONAL_EMAIL_KINDS)[number]

export type TransactionalEmailInput =
  | {
      kind: 'auth_magic_link'
      actionUrl: string
      /**
       * Present when an agent started this sign-in. The human reads it back to
       * whatever asked; absent means the browser flow, which only needs the
       * button.
       */
      code?: string
      /** Self-asserted by the requesting client, so the human knows who asked. */
      clientName?: string
      /**
       * Supplied by the caller rather than read from `@repo/contract`: this
       * package deliberately knows no TTL arithmetic, and a number written here
       * would be a second copy of one that has already gone stale once.
       */
      expiresInMinutes?: number
    }
  | {
      kind: 'workspace_invite'
      actionUrl: string
      role: 'editor' | 'viewer'
    }
  | {
      kind: 'share_invite'
      actionUrl: string
      sharerName: string
      folderName: string
    }
  | {
      kind: 'train_complete'
      actionUrl: string
      jobId: string
      recipientName?: string
    }
