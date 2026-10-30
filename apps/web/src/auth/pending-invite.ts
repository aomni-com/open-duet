export const PENDING_INVITE_COOKIE = 'duet_pending_invite'
export const PENDING_INVITE_MAX_AGE_SECONDS = 60 * 60
const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/

export function normalizedPendingInviteToken(token: string): string {
  return INVITE_TOKEN_PATTERN.test(token) ? token : 'invalid'
}

export function clearPendingInviteCookie(): string {
  return `${PENDING_INVITE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}
