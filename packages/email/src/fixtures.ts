import type { TransactionalEmailInput } from './contracts'

export const TRANSACTIONAL_EMAIL_FIXTURES = [
  {
    kind: 'auth_magic_link',
    actionUrl: 'https://app.duet.so/auth/verify?token=preview-magic-link',
    code: 'RNP4-4Y37',
    clientName: 'Claude Code',
    expiresInMinutes: 10,
  },
  {
    kind: 'workspace_invite',
    actionUrl: 'https://app.duet.so/invite/preview-workspace',
    role: 'editor',
  },
  {
    kind: 'share_invite',
    actionUrl: 'https://app.duet.so/share/preview-folder',
    sharerName: 'Priya Nanduri-Williams',
    folderName: 'International launch plans — final review',
  },
  {
    kind: 'train_complete',
    actionUrl: 'https://app.duet.so/w/north-star-labs/train',
    jobId: 'train_2026_07_18_customer-support-knowledge-refresh',
    recipientName: 'Sofía Nguyễn',
  },
] as const satisfies readonly TransactionalEmailInput[]
